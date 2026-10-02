/**
 * 登录请求里的手机号 / 密码做过一层混淆：
 * 去混淆后的实现是逐字符与 0x65 异或（源码 packages/core/utils/encode.ts）。
 */
export function encodeCredential(input: string): string {
  let out = "";
  for (const char of input) {
    out += String.fromCharCode(char.charCodeAt(0) ^ 0x65);
  }
  return out;
}
