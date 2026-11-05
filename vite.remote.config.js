import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
// Block 24b: the mobile web app served by the remote gateway at /remote/.
export default defineConfig({plugins:[react()],base:'./',publicDir:'remote-public',build:{outDir:'dist/remote',emptyOutDir:true,rollupOptions:{input:'remote.html'}}});
