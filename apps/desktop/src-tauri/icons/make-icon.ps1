Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = "Stop"

$size = 1024
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::FromArgb(63, 93, 75))

function New-RoundedPath([int]$x, [int]$y, [int]$w, [int]$h, [int]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, $r, $r, 180, 90)
  $p.AddArc($x + $w - $r, $y, $r, $r, 270, 90)
  $p.AddArc($x + $w - $r, $y + $h - $r, $r, $r, 0, 90)
  $p.AddArc($x, $y + $h - $r, $r, $r, 90, 90)
  $p.CloseFigure()
  return $p
}

# 纸
$paper = New-RoundedPath 140 140 744 744 56
$g.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(251, 248, 241))), $paper)

# 墨滴：圆 + 上方三角
$ink = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(43, 39, 35))
$g.FillEllipse($ink, 437, 330, 150, 150)
$pts = [System.Drawing.Point[]]@(
  (New-Object System.Drawing.Point(512, 262)),
  (New-Object System.Drawing.Point(444, 392)),
  (New-Object System.Drawing.Point(580, 392))
)
$g.FillPolygon($ink, $pts)

# 界行
$rule = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(196, 186, 171))
$g.FillRectangle($rule, 402, 606, 220, 10)

$g.Dispose()
$out = Join-Path $PSScriptRoot "source.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Get-Item $out | Select-Object Name, Length
