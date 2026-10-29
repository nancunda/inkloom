use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 窗口里的等待页最长等多久：首启要跑 tsx 编译，慢机器上 20 秒也正常
const BOOT_TIMEOUT: Duration = Duration::from_secs(90);

struct Server(Mutex<Option<Child>>);

fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

/// 服务端目录：打包后在资源目录；开发时退回仓库里的便携版
fn server_root(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(custom) = std::env::var("INKLOOM_TAURI_SERVER") {
        return PathBuf::from(custom);
    }
    if let Ok(dir) = app.path().resource_dir() {
        let candidate = dir.join("server");
        if candidate.join("node.exe").exists() {
            return candidate;
        }
    }
    // 开发：beforeDevCommand 把便携版拷到了 src-tauri/server
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("server")
}

/// 桌面版的配置目录：日志与 .env 都放这里，与书库（~/inkloom）分开
fn app_dir() -> Option<PathBuf> {
    let dir = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?.join("inkloom");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn log_path() -> Option<PathBuf> {
    Some(app_dir()?.join("server.log"))
}

fn spawn_server(app: &tauri::AppHandle, port: u16) -> Result<Child, String> {
    let root = server_root(app);
    let exe = root.join("node.exe");
    if !exe.exists() {
        return Err(format!("找不到本地服务端：{}", exe.display()));
    }

    let mut cmd = Command::new(&exe);
    let mut args = vec!["app/node_modules/tsx/dist/cli.mjs".to_string()];
    if let Some(dir) = app_dir() {
        // ★ 把 .env 放到用户目录：装在程序目录里的 .env 会随升级/卸载一起没掉。
        //   设置页写入的也是这个文件（服务端读 INKLOOM_ENV_FILE），重启后自动生效。
        let env_file = dir.join(".env");
        args.push(format!("--env-file-if-exists={}", env_file.display()));
        cmd.env("INKLOOM_ENV_FILE", &env_file);
    }
    args.push("app/apps/api/src/server.ts".to_string());

    cmd.args(&args)
        .current_dir(&root)
        .env("PORT", port.to_string());

    if std::env::var_os("INKLOOM_LIBRARY").is_none() {
        // 书库与 CLI / 浏览器版保持一致：默认 ~/inkloom，外部显式设置时尊重外部
        if let Some(home) = home_dir() {
            cmd.env("INKLOOM_LIBRARY", home.join("inkloom"));
        }
    }

    if let Some(log) = log_path() {
        if let Ok(file) = std::fs::File::create(&log) {
            if let Ok(err) = file.try_clone() {
                cmd.stdout(Stdio::from(file)).stderr(Stdio::from(err));
            }
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 不让 node 弹一个黑框
        cmd.creation_flags(0x0800_0000);
    }

    cmd.spawn()
        .map_err(|e| format!("启动本地服务失败：{e}"))
}

/// 探活：端口能连上不代表就绪，真正 GET 一次 /api/library 看 200
fn wait_ready(port: u16, timeout: Duration) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect(&addr) {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(1200)));
            let request = format!(
                "GET /api/library HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            );
            if stream.write_all(request.as_bytes()).is_ok() {
                let mut buf = [0u8; 64];
                if let Ok(n) = stream.read(&mut buf) {
                    if String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200") {
                        return true;
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    false
}

fn show_error(window: &WebviewWindow, message: &str) {
    let json = serde_json::to_string(message).unwrap_or_else(|_| "\"启动失败\"".to_string());
    let _ = window.eval(format!(
        "window.__inkloomBootError && window.__inkloomBootError({json});"
    ));
}

fn boot(app: tauri::AppHandle, window: WebviewWindow) {
    let port = match free_port() {
        Ok(port) => port,
        Err(e) => return show_error(&window, &format!("分配端口失败：{e}")),
    };

    let child = match spawn_server(&app, port) {
        Ok(child) => child,
        Err(e) => return show_error(&window, &e),
    };
    *app.state::<Server>().0.lock().unwrap() = Some(child);

    if !wait_ready(port, BOOT_TIMEOUT) {
        if let Some(mut child) = app.state::<Server>().0.lock().unwrap().take() {
            let _ = child.kill();
        }
        let log = log_path()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "（没有日志路径）".to_string());
        return show_error(
            &window,
            &format!("本地服务在 {} 秒内没有就绪。\n日志：{log}", BOOT_TIMEOUT.as_secs()),
        );
    }

    if let Ok(url) = format!("http://127.0.0.1:{port}/").parse() {
        if let Err(e) = window.navigate(url) {
            show_error(&window, &format!("打开书页失败：{e}"));
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        // 单实例：再双击一次只是把已有窗口唤到前台，不会再起一个服务端
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(Server(Mutex::new(None)))
        .setup(|app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("inkloom")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1100.0, 720.0)
                .center()
                .build()?;

            let handle = app.handle().clone();
            let target = window.clone();
            std::thread::spawn(move || boot(handle, target));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("无法启动 inkloom");

    app.run(|app, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            if let Some(mut child) = app.state::<Server>().0.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
}
