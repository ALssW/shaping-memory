/**
 * apps/mobile/app.config.js
 *
 * 【为什么需要它】app.json 是随仓库分发的公共配置，不应携带与个人 Expo 账号绑定的
 * 项目标识 —— 否则贡献者克隆后会指向他人的 EAS 项目。因此把这一项从 app.json 中剥离，
 * 改由本文件按环境变量注入：仓库分发的配置保持中立，本机构建仍能带上自己的项目标识。
 *
 * 【本文件为什么可以提交】这里只有「读取环境变量并注入」的通用逻辑，不含任何个人值；
 * 实际取值写在同目录的 .env 中，该文件已被仓库根 .gitignore 排除。
 *
 * 【Expo 的解析规则】同时存在 app.json 与 app.config.js 时，以 app.json 为基础配置，
 * 由本文件导出的对象覆盖；未配置 EXPO_PROJECT_ID 时原样返回，效果等同于只有 app.json。
 *
 * 【取值来源】环境变量 EXPO_PROJECT_ID，由同目录的 .env 提供。
 */
module.exports = ({ config }) => {
  const projectId = process.env.EXPO_PROJECT_ID;

  // 未配置时原样返回，不写入任何内容 —— 避免他人误用不属于自己的 EAS 项目
  if (!projectId) {
    return config;
  }

  return {
    ...config,
    extra: {
      ...config.extra,
      eas: { projectId },
    },
  };
};