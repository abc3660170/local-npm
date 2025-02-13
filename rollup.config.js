import typescript from "@rollup/plugin-typescript";
export default {
    input: 'lib/index.ts', // 入口文件，根据项目实际情况调整
    output: {
      file: 'dist/index.js', // 输出文件
      format: 'esm',          // 可选：'cjs' (Node) 或 'esm' (ES模块) 或其他格式
      sourcemap: true         // 可选：生成 sourcemap 方便调试
    },
    plugins: [typescript()],
    external: [/* 列出不需要打包进来的外部依赖，例如 'lodash' */]
};