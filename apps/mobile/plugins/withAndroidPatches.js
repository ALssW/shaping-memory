/**
 * apps/mobile/plugins/withAndroidPatches.js
 *
 * 把 7 处「只能手改原生工程」的补丁固化成 config plugin：这样 `npx expo prebuild`
 * （含 `--clean`）之后，原生工程会自动回到「可打包」状态，不再依赖开发者手动修改若干行。
 *
 * 七处补丁各自的由来：
 *   1. reactNativeArchitectures —— 只编一个 ABI，省掉 3/4 的原生编译时间。
 *      真机是 arm64-v8a，模拟器（MuMu / AVD）是 x86_64，按当前调试目标切换。
 *      ABI 选错时的表现很隐晦：libexpo-modules-core.so 不会进 APK（其余 .so 来自
 *      预编译 AAR、自带全 ABI，因此不会一起缺席），启动即红屏
 *      "Cannot read property 'EventEmitter' of undefined"，
 *      同时 logcat 报 SoLoaderDSONotFoundError: libexpo-modules-core.so。
 *   2. newArchEnabled = false —— 新架构的 codegen 会把生成源文件的绝对路径当 CMake
 *      对象名，本项目路径较长会撞 Windows 260 字符上限；关掉即不产生 codegen 目标
 *      （Expo SDK 52 仍支持旧架构）。
 *   3. app/build.gradle 的 extraPackagerArgs —— monorepo 下 RN 插件会把入口文件相对化
 *      成 "index.js"，Metro 于是从仓库根解析不到；补一条绝对路径的 --entry-file，
 *      expo 的参数解析器倒序扫描且不覆盖已设置的键，最后这条因此生效。
 *   4. AndroidManifest 的 usesCleartextTraffic = true —— 开发期走 http 连本机 API。
 *   5. gradle-wrapper 的发行包改成 `-bin` —— 模板默认 `-all`（多带了源码与文档）。本机对
 *      services.gradle.org 的 TLS 校验过不去，只能吃本地缓存，而缓存里只有 `-bin`；
 *      不改就会在 `--clean` 之后卡在 wrapper 下载（PKIX path building failed）。
 *   6. MainActivity 里注释掉 setTheme(R.style.AppTheme) —— 让开屏标记真的看得见。
 *      prebuild 出的 Manifest 给 Activity 挂的是 Theme.App.SplashScreen，它的 windowBackground
 *      指向 layer-list（纯深底 + 居中 200dp 品牌图）；但模板生成的 onCreate 第一件事就是
 *      setTheme(AppTheme)，而 AppTheme 的 windowBackground 是纯色 @color/activityBackground，
 *      于是带 logo 的那张背景在首帧前就被顶掉了 —— 表现是从点图标到 JS 就绪为止只有一片纯深色。
 *      模板那行注释写着 "required for expo-splash-screen"，本项目没装该包，因此可以安全去掉。
 *      去掉后 Activity 主题保持 Theme.App.SplashScreen（parent 就是 AppTheme，其余属性照旧继承），
 *      layer-list 会一直垫在 RN 根视图之下，与 App.tsx 里同尺寸（200dp）的 JS 镜像层无缝衔接。
 *   7. app/build.gradle 的 release 签名 —— 模板默认让 release 借用 debug 密钥，那个签不出能上架的包。
 *      凭据（keystore + 口令）放在 apps/mobile/credentials/，刻意留在 android/ 之外：
 *      `prebuild --clean` 会删掉整个 android/，放里面会被清掉。读不到凭据就退化为 debug 签名，
 *      这样刚 clone 的仓库也能直接跑 assembleRelease 冒烟；正式发版必须有 credentials/。
 *
 * 【刻意不写的属性：android.kotlinVersion】
 *   prebuild 出的 android/build.gradle 是 `kotlinVersion = findProperty('android.kotlinVersion') ?: '1.9.25'`。
 *   这个值会被 expo-modules-core 拿去查「Compose 编译器版本映射表」（1.9.24→1.5.14、1.9.25→1.5.15）。
 *   而真正生效的 kotlin-gradle-plugin 版本由 RN 0.76.9 的版本目录钉死（@react-native/gradle-plugin
 *   的 libs.versions.toml 里 kotlin = "1.9.25"）。一旦这里覆盖成 1.9.24，Compose 编译器就会选到
 *   要求 Kotlin 1.9.24 的 1.5.14，与实际编译器 1.9.25 对不上，编译直接报版本不匹配
 *   （compileDebugKotlin FAILED）。因此这一项必须保留模板默认值，不得覆盖。
 *
 * 本项目 android/ 是 prebuild 产物且已 gitignore，这些补丁只在本文件里维护。
 */
const fs = require('fs');
const path = require('path');
const {
  AndroidConfig,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withGradleProperties,
  withMainActivity,
} = require('@expo/config-plugins');

/** 当前调试目标的 ABI：真机 arm64-v8a / 模拟器 x86_64（写 `arm64-v8a,x86_64` 可一次构建两用） */
const ARCHITECTURES = 'arm64-v8a';
/** 6 号补丁的幂等标记：出现即代表 setTheme 已被注释 */
const NO_SET_THEME_MARK = '[withAndroidPatches] keep SplashScreen theme';
/** 3 号补丁要写进 react 块的两行；$projectRoot 是 app/build.gradle 里已有的变量 */
const ENTRY_FILE_LINE = [
  '// [withAndroidPatches] monorepo 下入口必须给绝对路径，理由见 plugins/withAndroidPatches.js',
  'extraPackagerArgs = ["--entry-file", file("$projectRoot/index.js").absolutePath]',
];

/** 按被替换那一行的缩进写回（模板里它在 react 块内，缩进 4 空格） */
const withIndent = (indent) => ENTRY_FILE_LINE.map((line) => indent + line).join('\n');

/**
 * 在 gradle.properties 的条目数组里原地 upsert：存在就改值，不存在就追加。
 * 该数组元素形如 { type: 'property', key, value } 与 { type: 'comment', value }。
 */
function upsertProperty(items, key, value) {
  const existing = items.find((item) => item.type === 'property' && item.key === key);
  if (existing) {
    existing.value = value;
    return;
  }
  items.push({ type: 'property', key, value });
}

/** 补丁 1~2：两个 gradle 属性（kotlinVersion 见文件头的「刻意不写」说明） */
const withGradlePropertyPatches = (config) =>
  withGradleProperties(config, (cfg) => {
    upsertProperty(cfg.modResults, 'reactNativeArchitectures', ARCHITECTURES);
    upsertProperty(cfg.modResults, 'newArchEnabled', 'false');
    return cfg;
  });

/** 补丁 3：给 react 块塞入绝对路径入口 —— 模板里那一行默认是注释态，这里替换它 */
const withEntryFilePatch = (config) =>
  withAppBuildGradle(config, (cfg) => {
    const source = cfg.modResults.contents;
    // 幂等：已打过补丁就直接返回，重复 prebuild 不会写两遍
    if (source.includes('$projectRoot/index.js')) return cfg;

    const commentLine = /^([ \t]*)\/\/[ \t]*extraPackagerArgs[ \t]*=[ \t]*\[\][ \t]*$/m;
    if (commentLine.test(source)) {
      cfg.modResults.contents = source.replace(commentLine, (_line, indent) => withIndent(indent));
      return cfg;
    }
    // 模板若把该键去掉了注释：直接改写那一行
    const activeLine = /^([ \t]*)extraPackagerArgs[ \t]*=.*$/m;
    if (activeLine.test(source)) {
      cfg.modResults.contents = source.replace(activeLine, (_line, indent) => withIndent(indent));
      return cfg;
    }
    // 上游模板改版：宁可让 prebuild 直接失败，也不要静默产出打不出包的原生工程
    throw new Error('[withAndroidPatches] app/build.gradle 里找不到 extraPackagerArgs 的落点');
  });

/** 补丁 4：允许明文 http（开发期连本机 API） */
const withCleartextTrafficPatch = (config) =>
  withAndroidManifest(config, (cfg) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    application.$['android:usesCleartextTraffic'] = 'true';
    return cfg;
  });

/** 补丁 5：gradle-wrapper 的发行包按 `-bin` 取（`-all` 在本机下不来，理由见文件头） */
const withGradleWrapperPatch = (config) =>
  withDangerousMod(config, [
    'android',
    (cfg) => {
      const file = path.join(cfg.modRequest.platformProjectRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties');
      if (!fs.existsSync(file)) return cfg;
      const source = fs.readFileSync(file, 'utf8');
      /* 只把发行包后缀从 -all 换成 -bin，版本号跟着模板走（上游升版时不必改这里）；
         幂等：已经是 -bin 时 replace 不命中，写回内容与原文一致 */
      const patched = source.replace(/-(bin|all)\.zip/g, '-bin.zip');
      if (patched !== source) fs.writeFileSync(file, patched);
      return cfg;
    },
  ]);

/** 补丁 6：注释掉 MainActivity 的 setTheme，让开屏 layer-list 撑到 JS 就绪（理由见文件头） */
const withSplashRetentionPatch = (config) =>
  withMainActivity(config, (cfg) => {
    const source = cfg.modResults.contents;
    // 幂等：已经注释过就不再动手（prebuild --clean 后是干净模板，这里必命中一次）
    if (source.includes(NO_SET_THEME_MARK)) return cfg;

    // 只认「整行、未被注释」的那一句。缩进按原样保留，避免破坏 kt 文件排版
    const active = /^([ \t]*)setTheme\(R\.style\.AppTheme\);[ \t]*$/m;
    if (!active.test(source)) {
      // 上游模板改版：宁可 prebuild 直接失败，也不要静默出一个「开屏没 logo」的包
      throw new Error('[withAndroidPatches] MainActivity 里找不到 setTheme(R.style.AppTheme); 的落点');
    }
    cfg.modResults.contents = source.replace(
      active,
      (_line, indent) => `${indent}// ${NO_SET_THEME_MARK}\n${indent}// setTheme(R.style.AppTheme);`,
    );
    return cfg;
  });

/** 补丁 7 在 app/build.gradle 里要替换的三处模板原文；任一找不到就抛错，绝不静默出「没签名」的包 */
const SIGNING_ANCHORS = {
  projectRootLine: 'def projectRoot = rootDir.getAbsoluteFile().getParentFile().getAbsolutePath()',
  signingConfigsBlock: [
    '    signingConfigs {',
    '        debug {',
    "            storeFile file('debug.keystore')",
    "            storePassword 'android'",
    "            keyAlias 'androiddebugkey'",
    "            keyPassword 'android'",
    '        }',
    '    }',
  ].join('\n'),
  releaseSigningLine: [
    '            // Caution! In production, you need to generate your own keystore file.',
    '            // see https://reactnative.dev/docs/signed-apk-android.',
    '            signingConfig signingConfigs.debug',
  ].join('\n'),
};

/** 读取 credentials/keystore.properties 的 Groovy 片段，插在 projectRoot 定义之后 */
const KEYSTORE_LOADER = [
  '',
  '/* [withAndroidPatches] release 签名凭据的读取。',
  '   文件刻意放在 android/ 之外 —— prebuild --clean 会把 android/ 整个删掉。',
  '   读不到就退化为 debug 签名，保证刚 clone 的仓库也能直接跑 assembleRelease 冒烟；',
  '   正式发版必须存在 credentials/keystore.properties 及其指向的 .keystore。 */',
  'def keystorePropsFile = new File(projectRoot, "credentials/keystore.properties")',
  'def keystoreProps = new Properties()',
  'if (keystorePropsFile.exists()) {',
  '    keystorePropsFile.withInputStream { keystoreProps.load(it) }',
  '}',
].join('\n');

/** 补丁 7：release 用自有密钥签名（模板默认借 debug 密钥，那个签不了发布） */
const withReleaseSigning = (config) =>
  withAppBuildGradle(config, (cfg) => {
    const source = cfg.modResults.contents;
    // 幂等：已打过就原样返回
    if (source.includes('keystorePropsFile')) return cfg;

    const { projectRootLine, signingConfigsBlock, releaseSigningLine } = SIGNING_ANCHORS;
    for (const anchor of [projectRootLine, signingConfigsBlock, releaseSigningLine]) {
      if (!source.includes(anchor)) {
        throw new Error(`[withAndroidPatches] app/build.gradle 里找不到签名补丁的落点：\n${anchor}`);
      }
    }

    cfg.modResults.contents = source
      .replace(projectRootLine, projectRootLine + KEYSTORE_LOADER)
      .replace(
        signingConfigsBlock,
        [
          signingConfigsBlock.replace(/\n    \}$/, ''),
          '        /* [withAndroidPatches] 自有 release 密钥；缺凭据文件时退化为 debug 密钥 */',
          '        release {',
          '            if (keystorePropsFile.exists()) {',
          "                storeFile new File(projectRoot, keystoreProps['storeFile'])",
          "                storePassword keystoreProps['storePassword']",
          "                keyAlias keystoreProps['keyAlias']",
          "                keyPassword keystoreProps['keyPassword']",
          '            } else {',
          "                storeFile file('debug.keystore')",
          "                storePassword 'android'",
          "                keyAlias 'androiddebugkey'",
          "                keyPassword 'android'",
          '            }',
          '        }',
          '    }',
        ].join('\n'),
      )
      .replace(
        releaseSigningLine,
        [
          '            /* [withAndroidPatches] 模板默认借 debug 密钥，签不出可上架的包 */',
          '            signingConfig signingConfigs.release',
        ].join('\n'),
      );
    return cfg;
  });

module.exports = (config) =>
  withReleaseSigning(
    withSplashRetentionPatch(
      withGradleWrapperPatch(withCleartextTrafficPatch(withEntryFilePatch(withGradlePropertyPatches(config)))),
    ),
  );