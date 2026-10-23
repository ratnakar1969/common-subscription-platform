import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL || "debug",

  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        },
});

export default logger;