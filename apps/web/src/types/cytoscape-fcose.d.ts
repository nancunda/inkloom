// cytoscape-fcose 不自带类型（2.2.0）：按 cytoscape 官方的扩展签名补一份。
declare module 'cytoscape-fcose' {
  import type { Ext } from 'cytoscape'

  const ext: Ext
  export default ext
}
