/** Keep expected command-line rejections readable instead of printing Node internals. */
export function installCliErrorHandler() {
  const fail = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`错误：${message}`);
    process.exitCode = 1;
  };
  process.once('uncaughtException', fail);
  process.once('unhandledRejection', fail);
}
