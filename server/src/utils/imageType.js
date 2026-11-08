/**
 * 根据文件"魔数"（前几个字节）判断真实图片类型
 *
 * 为什么不能只看扩展名或 Content-Type:
 *   这两个都是客户端说了算的。攻击者把 shell.php 改名成 a.png 再声明 image/png，
 *   服务端如果信了，就等于允许上传任意文件。
 *   读文件头是唯一无法伪造的部分（除非文件本身就不是那个格式）。
 *
 * 支持的格式: JPEG / PNG / WebP
 * 说明: 这里只做"是不是这个格式"的判定，不做完整解码。
 *       真要防"魔数对但内容是坏的"图片，需要引入 sharp 之类的解码库，
 *       本项目不处理用户上传的图片内容，故只需魔数 + 体积限制。
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ext: 'png', mime: 'image/png' };
  }

  // WebP: 'RIFF' .... 'WEBP'
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }

  return null;
}

export const ALLOWED_IMAGE_MIME = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
