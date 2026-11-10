import { build } from 'tsup';
await build({ entry: ['src/index.ts'], format: ['esm', 'cjs'], dts: true, clean: true, sourcemap: true, target: 'node20' });
await build({ entry: ['src/cli.ts'], format: ['esm'], splitting: false, sourcemap: true, target: 'node20' });
