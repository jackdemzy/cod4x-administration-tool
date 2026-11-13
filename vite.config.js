import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {withDesktopCsp} from './lib/desktop-csp.mjs';
// Security audit 4.18.26 (A6-2): the built desktop page carries a strict CSP.
const desktopCsp = {name:'desktop-csp', apply:'build', transformIndexHtml:{order:'post', handler:withDesktopCsp}};
export default defineConfig({plugins:[react(), desktopCsp],base:'./'});
