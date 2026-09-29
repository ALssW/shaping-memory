/**
 * apps/mobile/babel.config.js
 *
 * 用 Expo 的预设即可：它已经包含 TS / JSX 的处理，不需要额外插件。
 */
module.exports = function babelConfig(api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};