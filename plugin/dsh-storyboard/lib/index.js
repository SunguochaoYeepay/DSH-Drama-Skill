/**
 * dsh-storyboard 宿主半。
 *
 * 里程碑 0（活体验证）：宿主半暂时只做一件事——证明这个外挂包被 dsh web 装上了。
 * 里程碑 1 会在这里加：workspaceFiles 读取 storyboard.json、以及写回的 Remote 端点
 * （TypertRemoteService + @Remote，见 docs/cookbook/adding-a-remote-api.md）。
 */

/** Cordis 诊断里的插件名。 */
export const name = 'dsh-storyboard'

/**
 * 插件入口。
 * @param ctx - 宿主根上下文。
 */
export function apply(ctx) {
  const logger = ctx && typeof ctx.logger === 'object' ? ctx.logger : undefined
  if (logger && typeof logger.info === 'function') logger.info('[dsh-storyboard] host half loaded')
  else console.log('[dsh-storyboard] host half loaded')
}
