/**
 * bun test 的 preload：把 "vscode" 模块替换成 stub。
 * 由 bunfig.toml 的 [test] preload 引入，在任何测试文件加载之前执行。
 */
import { mock } from "bun:test";
import * as stub from "./vscode-stub";

mock.module("vscode", () => stub);
