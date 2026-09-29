/**
 * apps/api/src/privacy/tokens.ts
 *
 * 静态文件的访问凭证（「授权票据」）。
 *
 * 【为什么不用 JWT 库】票据要能被 <img src> 直接带走 —— 浏览器给图片发请求时不会带
 * Authorization 头，所以票据只能进 URL query。它是一次性的、短时效的、权限范围极窄的
 * 凭证，用 HMAC 自签一个紧凑串即可，无需引入完整的 JWT 语义；也因此这三行代码可以在
 * 任何层（含 FilesController）复用，不依赖 Nest 的 DI。
 *
 * 【安全边界】票据只承载「能看哪几张 / 什么角色」，不承载用户身份；密钥取 JWT_SECRET。
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** 票据内容 */
export interface AccessGrant {
  /** 授权角色（'share' 表示来自分享链接，仅凭 ids 放行） */
  role: string;
  /** 过期时刻（秒级 Unix 时间戳） */
  exp: number;
  /** 仅这批 id 可看；缺省 = 不限（角色授权） */
  ids?: string[];
}

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromBase64url = (input: string): Buffer =>
  Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function sign(secret: string, body: string): string {
  return base64url(createHmac('sha256', secret).update(body).digest());
}

/** 签发票据：`payload.signature` */
export function signGrant(secret: string, grant: AccessGrant): string {
  const body = base64url(JSON.stringify(grant));
  return `${body}.${sign(secret, body)}`;
}

/**
 * 校验票据。任何一环不通过（结构不对 / 签名不符 / 已过期）都返回 null，
 * 调用方按「没有票据」处理 —— 即匿名，绝不因为票据异常而放行。
 */
export function verifyGrant(secret: string, token: string | undefined): AccessGrant | null {
  if (!token) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;

  const expected = Buffer.from(sign(secret, body));
  const actual = Buffer.from(signature);
  // timingSafeEqual 要求长度一致：长度不同直接判否，不必也不能硬比
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const grant = JSON.parse(fromBase64url(body).toString('utf8')) as AccessGrant;
    return grant.exp * 1000 > Date.now() ? grant : null;
  } catch {
    return null;
  }
}

/** 分享链接的 token：URL 里出现的那串，128 位随机、不可枚举 */
export function newShareToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * 提取码：默认 4 位数字（需求定的 4~6 位区间取最短，够用且好念）。
 * 用 randomInt 而不是 Math.random —— 后者可预测，提取码是可暴力尝试的唯一屏障。
 */
export function newAccessCode(length = 4): string {
  return Array.from({ length }, () => randomInt(0, 10)).join('');
}