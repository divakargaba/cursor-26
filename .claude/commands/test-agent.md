# Claude Code Custom Command: /test-agent

## Description
Runs a simulated agent loop from the CLI to quickly verify if the AI correctly interprets an action or command, bypassing the Electron UI. Useful for debugging prompt injection or syntax errors in `agent.js`.

## How to use
Type `/test-agent "your command here"` in Claude Code.

```bash
node -e "
const { Agent } = require('./src/agent');
// Dummy computer and browser implementations
const mockComputer = {
  runCommand: async (cmd) => ({ ok: true, stdout: 'Mocked cmd' }),
  focusWindow: async (p) => ({ ok: true, title: 'Mocked Window' }),
  getScreenSize: () => ({ width: 1920, height: 1080 })
};
const mockBrowser = {
  isConnected: () => true,
  getPageContext: async () => ({ url: 'mock', title: 'Mock', elements: [] })
};

const agent = new Agent({ 
  computer: mockComputer, 
  browser: mockBrowser,
  screenshotFn: async () => ({ ok: false, error: 'Mocked' }),
  blurOverlayFn: () => {},
  showConfirmationFn: async () => true,
});

async function run() {
  const input = process.argv[2];
  if(!input) {
    console.log('Usage: /test-agent \"command\"');
    process.exit(1);
  }
  console.log('[Test] Simulated input:', input);
  
  // A quick stub to see what tools the agent *would* have called.
  // In a real implementation we'd run the loop.
  console.log('[Test] Note: In a full environment this would trigger Anthony sdk calls.');
}
run();
" "$1"
```
