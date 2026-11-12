/**
 * 面板参数表 —— 全工程唯一的一份。
 *
 * 设备广播名是 EINK-<面板标识>-<MAC4>（例如 EINK-800-B21A），客户端据此
 * 判断该按哪种屏幕处理，不必为此再加一条 BLE 命令。
 *
 * 页面之间通过这个模块共用，避免各写一份而互相不一致。
 */

/* 各面板的默认抖动算法。之所以要分面板，是因为 hybrid 有个具体缺陷：
 * 它把亮度低于阈值的块交给"取最近的两色、逐像素随机混合"处理，而中性暗灰
 * 到 红/绿/蓝 的距离完全相等，PALETTE_CODES 又因 JS 的类数字键升序而把蓝
 * 排在前 —— 结果所有中性暗部都变成「黑 + 蓝随机噪声」。实测黑色占比只有
 * 26%，而同图 atkinson 是 46%，暗部既糊又不够黑。
 *
 * 1200 面板经上屏对比选定 atkinson（只扩散 3/4 误差，对比度最高、最不掺蓝）。
 * 800 面板维持 hybrid 未做实测对比，不是因为它更好，只是没人验过。 */
export const PANEL_PROFILES = {
  800:  { width: 800,  height: 480,  label: '800×480 六色',  dither: 'hybrid' },
  1200: { width: 1200, height: 1600, label: '1200×1600 六色', dither: 'atkinson' }
}

/** 名字里没有标识时按小屏处理 —— 兼容还没重烧的旧固件 */
export const DEFAULT_PANEL_TAG = '800'

/** Explicit selections must be recognized; never combine an unknown tag with
 * the small panel's dimensions. Legacy names without a tag still use 800. */
export function panelForTag(tag = DEFAULT_PANEL_TAG) {
  tag = String(tag)
  const profile = PANEL_PROFILES[tag]
  if (!profile) throw new Error('不支持的屏幕型号：' + tag)
  return Object.assign({ tag }, profile)
}

/**
 * 从广播名解析面板。旧名字无型号时兼容默认面板，未知显式型号报错。
 * @param {string} name 设备广播名，如 "EINK-1200-B21A"
 */
export function parsePanel(name) {
  const match = /^EINK-([^-]+)-/i.exec(String(name || ''))
  const tag = match ? match[1] : DEFAULT_PANEL_TAG
  return panelForTag(tag)
}

/**
 * 面板的两种合法栅格：宽×高（文件布局）与高×宽。
 *
 * 800×480 的文件布局是横的，1200×1600 的是竖的，所以标记横竖要按实际
 * 宽高判断，不能写死顺序。
 */
export function cropOptionsFor(panel) {
  const orientation = (w, h) => (w > h ? '横屏' : '竖屏')
  return [
    { w: panel.width,  h: panel.height, label: orientation(panel.width, panel.height) },
    { w: panel.height, h: panel.width,  label: orientation(panel.height, panel.width) }
  ]
}

/** 一帧图像在 SD 上的字节数（每像素 1 字节调色板码） */
export function panelBytes(panel) {
  return panel.width * panel.height
}

export function panelWireBytes(panel) {
  return Math.ceil(panelBytes(panel) * 3 / 8)
}
