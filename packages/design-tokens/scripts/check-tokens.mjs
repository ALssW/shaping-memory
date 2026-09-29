#!/usr/bin/env node
/**
 * check-tokens.mjs —— 设计 token 两端一致性守门脚本（零依赖）
 *
 * 背景：本仓库采用「零依赖手写对齐」方案，CSS / TS 两份产物是人手写的，
 *       因此必须有机器守门，防止某个端漏改、改名或改错值。
 *
 * 校验内容：
 *   1. tokens.json 可解析、DTCG 叶子格式合法（每个叶子必须带 $value）
 *   2. 按规范 §2.1 的命名映射规则，从 tokens.json 反推出两端应有的 token 名称
 *   3. 两个产物文件的 token 名称集合与推导结果逐一比对（缺 / 多 / 重复都算失败）
 *   4. 标量类 token 的值逐个比对（数组与配方型 token 跳过值比对，仅比名称）
 *
 * 用法（仓库根目录）：node packages/design-tokens/scripts/check-tokens.mjs
 * 退出码：0 = 通过，1 = 失败
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS_JSON = path.join(ROOT, 'tokens.json');
const WEB_CSS = path.join(ROOT, 'web', 'tokens.css');
const WEB_TS = path.join(ROOT, 'web', 'tokens.ts');

/** 值比对时跳过的族：数组型（字体族栈）、配方型（阴影、弹簧、贝塞尔曲线） */
const SKIP_VALUE_GROUPS = new Set(['elevation']);
const SKIP_VALUE_LEAVES = new Set(['font.family', 'motion.spring', 'motion.easing']);

const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);

/* ---------------- 1. 收集 tokens.json 叶子 ---------------- */

/** 递归收集叶子：[路径数组, $value, $type]，$type 就近继承组级声明 */
function collectLeaves(node, trail = [], inherited = null) {
  const leaves = [];
  const type = node.$type ?? inherited;
  for (const key of Object.keys(node)) {
    if (key.startsWith('$')) continue;
    const child = node[key];
    if (child && typeof child === 'object' && '$value' in child) {
      leaves.push({ path: [...trail, key], value: child.$value, type: child.$type ?? type });
    } else if (child && typeof child === 'object') {
      leaves.push(...collectLeaves(child, [...trail, key], type));
    } else {
      fail(`tokens.json: 非法节点 ${[...trail, key].join('.')} —— 既不是 $value 也不是分组`);
    }
  }
  return leaves;
}

const tokens = JSON.parse(fs.readFileSync(TOKENS_JSON, 'utf8'));
const leaves = collectLeaves(tokens);
const leafPaths = leaves.map((l) => l.path);

/* ---------------- 2. 推导两端名称 ---------------- */

const toKebab = (segs) => segs.join('-');
// 数字段在 TS 标识符里非法，统一加 s 前缀（规范 §2.1）
const segToIdent = (s) => (/^\d/.test(s) ? 's' + s : s);
const toCamel = (segs) =>
  segs
    .map((s, i) => {
      const id = segToIdent(s).replace(/-(.)/g, (_, c) => c.toUpperCase());
      return i === 0 ? id : id.charAt(0).toUpperCase() + id.slice(1);
    })
    .join('');

/** CSS 变量名：除 motion.spring.* 外全部输出（规范 §2.2） */
const expectCss = new Map();
for (const { path: p, value, type } of leaves) {
  if (p[0] === 'motion' && p[1] === 'spring') continue;
  expectCss.set('--' + toKebab(p), { path: p, value, type });
}

/* ---------------- 3. 解析产物 ---------------- */

// —— CSS ——
const cssSrc = fs.readFileSync(WEB_CSS, 'utf8');
const cssDecls = new Map();
for (const m of cssSrc.matchAll(/(^|\s)(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
  const name = m[2];
  if (cssDecls.has(name)) fail(`tokens.css: 变量 ${name} 重复声明`);
  cssDecls.set(name, m[3].trim());
}
// 工具类里会复用变量（如 var(--color-accent)），但声明只会出现在 :root，故上面的正则足够

// —— TS：只截取 `const tokens = { ... }` 这个对象字面量并求值 ——
// 不做全局类型剥离（那会误伤字符串与注释），而是用花括号配对精确定位字面量边界。
const tsSrc = fs.readFileSync(WEB_TS, 'utf8');
let tsTokens = null;
try {
  const anchor = tsSrc.search(/const\s+tokens\s*=\s*\{/);
  if (anchor < 0) throw new Error('未找到 `const tokens = {` 声明');
  const braceStart = tsSrc.indexOf('{', anchor);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < tsSrc.length; i++) {
    if (tsSrc[i] === '{') depth++;
    else if (tsSrc[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error('对象字面量花括号未闭合');
  const literal = tsSrc.slice(braceStart, end + 1);
  tsTokens = new Function(`return (${literal});`)();
} catch (e) {
  fail(`tokens.ts: 无法解析（${e.message}）`);
}
const tsLeaves = new Map();
if (tsTokens) {
  // DTCG 里 $value 本身是普通对象时，它是一个「值对象」（如 motion.spring.smooth = {duration, bounce}），
  // 在 TS 中同样表现为嵌套对象。因此下探时必须在这个 key 处停下并整体记录，否则会被误拆成 duration/bounce 两个叶子。
  const valueObjectKeys = new Set(
    leaves
      .filter((l) => l.value && typeof l.value === 'object' && !Array.isArray(l.value))
      .map((l) => toCamel(l.path)),
  );
  // 用完整路径的 camelCase 串做键，避免同名叶子（如两个 default）互相覆盖
  const walkFull = (node, trail) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const k of Object.keys(node)) {
      const v = node[k];
      const key = toCamel(trail.concat(k));
      if (v && typeof v === 'object' && !Array.isArray(v) && !valueObjectKeys.has(key)) {
        walkFull(v, [...trail, k]);
      } else {
        tsLeaves.set(key, v);
      }
    }
  };
  walkFull(tsTokens, []);
}

/* ---------------- 4. 比对 ---------------- */

const norm = (s) => String(s).replace(/[\s'"]/g, '').toLowerCase();

// —— CSS 名称集合 ——
for (const [name, expect] of expectCss) {
  if (!cssDecls.has(name)) fail(`tokens.css 缺少变量 ${name}（对应 ${expect.path.join('.')}）`);
}
for (const name of cssDecls.keys()) {
  if (!expectCss.has(name)) fail(`tokens.css 多出变量 ${name} —— 不在 tokens.json 中`);
}
// —— CSS 值 ——
for (const [name, expect] of expectCss) {
  if (!cssDecls.has(name)) continue;
  if (SKIP_VALUE_GROUPS.has(expect.path[0])) continue;
  if (SKIP_VALUE_LEAVES.has(expect.path.slice(0, 2).join('.'))) continue;
  const want = norm(Array.isArray(expect.value) ? expect.value.join(',') : expect.value);
  const got = norm(cssDecls.get(name));
  if (want !== got) fail(`tokens.css 值不符 ${name}: 期望 ${want} / 实际 ${got}`);
}

// —— TS ——
if (tsTokens) {
  for (const { path: p, value, type } of leaves) {
    const key = toCamel(p);
    if (!tsLeaves.has(key)) {
      fail(`tokens.ts 缺少 tokens.${p.join('.')}`);
      continue;
    }
    if (SKIP_VALUE_GROUPS.has(p[0])) continue;
    if (SKIP_VALUE_LEAVES.has(p.slice(0, 2).join('.'))) continue;
    const got = tsLeaves.get(key);
    const want = Array.isArray(value) ? value.join(',') : value;
    const gotNorm = Array.isArray(got) ? got.join(',') : got;
    if (norm(want) !== norm(gotNorm)) {
      fail(`tokens.ts 值不符 ${p.join('.')}: 期望 ${want} / 实际 ${gotNorm}`);
    }
  }
  for (const key of tsLeaves.keys()) {
    const known = leafPaths.some((p) => toCamel(p) === key);
    if (!known) fail(`tokens.ts 多出 tokens 叶子 "${key}" —— 不在 tokens.json 中`);
  }
}

/* ---------------- 5. 输出 ---------------- */

console.log('设计 token 一致性校验');
console.log(`  tokens.json 叶子      : ${leaves.length}`);
console.log(`  CSS 变量（含跳过项）  : 期望 ${expectCss.size} / 实际 ${cssDecls.size}`);
console.log(`  TS 叶子               : 期望 ${leaves.length} / 实际 ${tsLeaves.size}`);
for (const n of notes) console.log(`  备注: ${n}`);
console.log('');

if (problems.length) {
  console.error(`校验失败，共 ${problems.length} 处问题：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('校验通过：两端 token 名称与数值均与 tokens.json 一致。');