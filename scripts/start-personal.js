const path = require("node:path");
process.env.COUNSEL_PERSONAL = "true";
process.env.HOST = "127.0.0.1";
process.env.COOKIE_SECURE = "false";
process.env.DATA_DIR ||= path.join(__dirname, "..", "data", "personal");
require("../server").start();
