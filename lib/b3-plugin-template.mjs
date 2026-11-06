// Block 16b: starter code and config for a custom B3 plugin (Python 2.7, B3 plugin API).
export function b3PluginClassName(name) {
  return `${String(name).split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('')}Plugin`;
}

export function renderB3PluginTemplate(name) {
  const cls = b3PluginClassName(name);
  const code = `# -*- coding: utf-8 -*-
# Custom B3 plugin "${name}", created from the COD4X CONTROL template.
# WARNING: this code runs inside B3 with all of B3's rights (database, RCON, files).
# Only keep code here that you wrote or fully reviewed.

__author__ = 'you'
__version__ = '1.0.0'

import b3
import b3.plugin


class ${cls}(b3.plugin.Plugin):

    def onStartup(self):
        self._adminPlugin = self.console.getPlugin('admin')
        if not self._adminPlugin:
            self.error('Could not find the admin plugin')
            return False
        self._register_commands()

    def getCmd(self, cmd):
        cmd = 'cmd_%s' % cmd
        if hasattr(self, cmd):
            return getattr(self, cmd)
        return None

    def _register_commands(self):
        if 'commands' in self.config.sections():
            for cmd in self.config.options('commands'):
                level = self.config.get('commands', cmd)
                sp = cmd.split('-')
                alias = None
                if len(sp) == 2:
                    cmd, alias = sp
                func = self.getCmd(cmd)
                if func:
                    self._adminPlugin.registerCommand(self, cmd, level, func, alias)
                    self.verbose('registered command: %s' % cmd)

    def cmd_${name}(self, data, client, cmd=None):
        """\\
        - example command, answers the caller
        """
        client.message('^7${name} is working.')
`;
  const config = `[commands]
${name}: 1

[settings]
`;
  return { code, config };
}
