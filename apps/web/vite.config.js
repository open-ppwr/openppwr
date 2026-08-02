import { defineConfig } from 'vite';

export default defineConfig({
  esbuild:{jsx:'automatic'},
  server:{host:'127.0.0.1',port:5173,proxy:{'/v1':{target:process.env.OPENPPWR_INTERNAL_API_URL || 'http://127.0.0.1:3100',changeOrigin:true},'/health':{target:process.env.OPENPPWR_INTERNAL_API_URL || 'http://127.0.0.1:3100',changeOrigin:true}}},
  build:{outDir:'dist/client',emptyOutDir:true,sourcemap:true},
});
