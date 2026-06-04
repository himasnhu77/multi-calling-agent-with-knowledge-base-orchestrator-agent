class Logger {
  #prefix;
  constructor(prefix = "APP") { this.#prefix = prefix; }

  #fmt(level, msg, ...args) {
    const ts = new Date().toISOString();
    console[level](`[${ts}] [${this.#prefix}] ${msg}`, ...args);
  }

  info(msg, ...args)  { this.#fmt("log",   msg, ...args); }
  warn(msg, ...args)  { this.#fmt("warn",  msg, ...args); }
  error(msg, ...args) { this.#fmt("error", msg, ...args); }
  debug(msg, ...args) {
    if (process.env.DEBUG) this.#fmt("log", `[DEBUG] ${msg}`, ...args);
  }
}

module.exports = Logger;
