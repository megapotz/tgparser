"use strict";

const path = require("node:path");

const ROOT = process.cwd();

const CHANNEL_LIST_FILE = process.env.CHANNEL_LIST_FILE || path.join(ROOT, "src", "l.txt");
const DB_PATH = process.env.CHANNEL_DB_PATH || path.join(ROOT, "channels.filtered.sqlite");
const MEDIA_ROOT = process.env.CHANNEL_MEDIA_DIR || path.join(ROOT, "media");
const TD_LIB_PATH = process.env.TDLIB_PATH || "/home/mike/td/build/libtdjson.so";
const TDLIB_DATABASE_DIR = process.env.TDLIB_DATABASE_DIR || path.join(ROOT, "tdlib", "database");
const TDLIB_FILES_DIR = process.env.TDLIB_FILES_DIR || path.join(ROOT, "tdlib", "files");

module.exports = {
  CHANNEL_LIST_FILE,
  DB_PATH,
  MEDIA_ROOT,
  TD_LIB_PATH,
  TDLIB_DATABASE_DIR,
  TDLIB_FILES_DIR
};
