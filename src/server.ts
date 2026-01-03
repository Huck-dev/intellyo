import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = 4445;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Store active WebSocket connections
const clients = new Set<WebSocket>();

// Server-side settings (can be overridden by client)
let serverSettings = {
  provider: 'ollama',
  apiKey: process.env.INTELLYO_API_KEY || '',
  model: '',
  testDir: process.env.TEST_DIR || '/home/huck/staryo/website/intellitester-tests'
};

// Settings endpoint
app.post('/api/settings', (req, res) => {
  const { provider, apiKey, model, testDir } = req.body;
  if (provider) serverSettings.provider = provider;
  if (apiKey) serverSettings.apiKey = apiKey;
  if (model) serverSettings.model = model;
  if (testDir) serverSettings.testDir = testDir;
  broadcast({ type: 'status', message: 'Settings updated' });
  res.json({ success: true });
});

app.get('/api/settings', (req, res) => {
  res.json({
    provider: serverSettings.provider,
    hasApiKey: !!serverSettings.apiKey,
    model: serverSettings.model,
    testDir: serverSettings.testDir
  });
});

// Get available Ollama models
app.get('/api/models', async (req, res) => {
  try {
    const { stdout } = await execAsync('ollama list');
    const lines = stdout.trim().split('\n').slice(1); // Skip header
    const models = lines.map(line => {
      const parts = line.split(/\s+/);
      return { name: parts[0], size: parts[2] };
    });
    res.json({ models });
  } catch (error) {
    res.json({ models: [], error: 'Ollama not available' });
  }
});

// Get available browsers
app.get('/api/browsers', (req, res) => {
  res.json({
    browsers: [
      { id: 'chrome', name: 'Chrome', icon: '🌐' },
      { id: 'firefox', name: 'Firefox', icon: '🦊' },
      { id: 'safari', name: 'Safari', icon: '🧭' },
    ]
  });
});

// Get available OS/platforms
app.get('/api/platforms', (req, res) => {
  res.json({
    platforms: [
      { id: 'desktop', name: 'Desktop', icon: '🖥️' },
      { id: 'mobile', name: 'Mobile', icon: '📱' },
      { id: 'tablet', name: 'Tablet', icon: '📱' },
    ]
  });
});

// Get test scenarios
app.get('/api/scenarios', (req, res) => {
  res.json({
    scenarios: [
      { id: 'login', name: 'Login Flow', description: 'Test user login with email/password' },
      { id: 'signup', name: 'Signup Flow', description: 'Test user registration' },
      { id: 'messages', name: 'Send Message', description: 'Test sending text messages' },
      { id: 'media', name: 'Send Media', description: 'Test sending images/videos' },
      { id: 'profile', name: 'View Profile', description: 'Test viewing user profiles' },
      { id: 'checkout', name: 'Checkout', description: 'Test purchase flow' },
      { id: 'settings', name: 'Settings', description: 'Test user settings' },
      { id: 'admin', name: 'Admin Dashboard', description: 'Test admin pages' },
      { id: 'smoke', name: 'Smoke Test', description: 'Quick test of all pages' },
    ]
  });
});

// List existing tests
app.get('/api/tests', async (req, res) => {
  try {
    const testsDir = serverSettings.testDir;
    const { stdout } = await execAsync(`ls ${testsDir}/*.yaml 2>/dev/null || echo ""`);
    const files = stdout.trim().split('\n').filter(f => f);
    const tests = files.map(f => ({
      name: path.basename(f, '.test.yaml'),
      path: f
    }));
    res.json({ tests });
  } catch (error) {
    res.json({ tests: [] });
  }
});

// Generate test
app.post('/api/generate', async (req, res) => {
  const { scenario, browser, platform, baseUrl, aiProvider, apiKey, model } = req.body;

  // Use request-level settings if provided, otherwise use server settings
  const provider = aiProvider || serverSettings.provider;
  const key = apiKey || serverSettings.apiKey;

  // Broadcast to WebSocket clients
  broadcast({ type: 'status', message: `Generating ${scenario} test for ${browser}...` });

  try {
    const testContent = generateTestYaml(scenario, browser, platform, baseUrl || 'http://localhost:4444');
    const testPath = `${serverSettings.testDir}/${scenario}-${browser}.test.yaml`;

    // Write test file
    const fs = await import('fs/promises');
    await fs.writeFile(testPath, testContent);

    broadcast({ type: 'success', message: `Test generated: ${testPath}` });
    res.json({ success: true, path: testPath });
  } catch (error: any) {
    broadcast({ type: 'error', message: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Run test
app.post('/api/run', async (req, res) => {
  const { testPath, browser, visible } = req.body;

  broadcast({ type: 'status', message: `Running test: ${path.basename(testPath)}` });

  const args = ['intellitester', 'run', testPath];
  if (visible) args.push('--visible');
  if (browser) args.push('--browser', browser);

  // Use test directory's parent as working directory
  const testDir = path.dirname(testPath);
  const workDir = path.dirname(testDir);

  const child = spawn('npx', args, {
    cwd: workDir,
    env: { ...process.env }
  });

  child.stdout.on('data', (data) => {
    broadcast({ type: 'output', message: data.toString() });
  });

  child.stderr.on('data', (data) => {
    broadcast({ type: 'output', message: data.toString() });
  });

  child.on('close', (code) => {
    broadcast({
      type: code === 0 ? 'success' : 'error',
      message: `Test finished with code ${code}`
    });
  });

  res.json({ success: true, message: 'Test started' });
});

// Credentials
const CREDENTIALS = {
  user: { email: 'newuser@test.com', password: 'Leonidas12!' },
  creator: { email: 'newcreator@test.com', password: 'Leonidas12!' }
};

// Generate test YAML based on scenario
function generateTestYaml(scenario: string, browser: string, platform: string, baseUrl: string): string {
  // Determine which credentials to use
  const isCreatorTest = scenario.includes('creator') || scenario.includes('admin');
  const creds = isCreatorTest ? CREDENTIALS.creator : CREDENTIALS.user;

  const tests: Record<string, string> = {
    login: `name: Login Flow Test (${browser})
platform: web

config:
  web:
    baseUrl: ${baseUrl}
    headless: false

variables:
  testEmail: ${creds.email}
  testPassword: ${creds.password}

steps:
  - type: navigate
    value: /login

  - type: wait
    timeout: 2000

  - type: screenshot
    name: login-${browser}-initial.png

  - type: input
    target:
      css: "input[type='email'], input[name='email'], #email"
    value: "{{testEmail}}"

  - type: input
    target:
      css: "input[type='password'], input[name='password'], #password"
    value: "{{testPassword}}"

  - type: screenshot
    name: login-${browser}-filled.png

  - type: tap
    target:
      css: "button[type='submit'], .login-button"

  - type: wait
    timeout: 3000

  - type: screenshot
    name: login-${browser}-result.png
`,

    signup: `name: Signup Flow Test (${browser})
platform: web

config:
  web:
    baseUrl: ${baseUrl}
    headless: false

variables:
  username: user_{{uuid}}
  email: ${creds.email}
  password: ${creds.password}

steps:
  - type: navigate
    value: /signup

  - type: wait
    timeout: 2000

  - type: screenshot
    name: signup-${browser}-initial.png

  - type: input
    target:
      css: "input[type='email'], input[name='email']"
    value: "{{email}}"

  - type: input
    target:
      css: "input[type='password'], input[name='password']"
    value: "{{password}}"

  - type: screenshot
    name: signup-${browser}-filled.png

  - type: tap
    target:
      css: "button[type='submit']"

  - type: wait
    timeout: 3000

  - type: screenshot
    name: signup-${browser}-result.png
`,

    messages: `name: Send Message Test (${browser})
platform: web

config:
  web:
    baseUrl: ${baseUrl}
    headless: false

variables:
  testEmail: ${creds.email}
  testPassword: ${creds.password}
  testMessage: Hello from automated test {{uuid}}

steps:
  # Login first
  - type: navigate
    value: /login

  - type: wait
    timeout: 2000

  - type: input
    target:
      css: "input[type='email'], input[name='email'], #email"
    value: "{{testEmail}}"

  - type: input
    target:
      css: "input[type='password'], input[name='password'], #password"
    value: "{{testPassword}}"

  - type: tap
    target:
      css: "button[type='submit'], .login-button"

  - type: wait
    timeout: 3000

  - type: screenshot
    name: messages-${browser}-after-login.png

  # Navigate to messages
  - type: navigate
    value: /messages

  - type: wait
    timeout: 2000

  - type: screenshot
    name: messages-${browser}-inbox.png

  # Try to compose a message
  - type: input
    target:
      css: "textarea, input[type='text'], .message-input"
    value: "{{testMessage}}"
    optional: true

  - type: screenshot
    name: messages-${browser}-compose.png

  - type: tap
    target:
      css: "button[type='submit'], .send-button"
    optional: true

  - type: wait
    timeout: 2000

  - type: screenshot
    name: messages-${browser}-sent.png
`,

    media: `name: Send Media Test (${browser})
platform: web

config:
  web:
    baseUrl: ${baseUrl}
    headless: false

variables:
  testEmail: ${creds.email}
  testPassword: ${creds.password}

steps:
  # Login first
  - type: navigate
    value: /login

  - type: wait
    timeout: 2000

  - type: input
    target:
      css: "input[type='email'], input[name='email'], #email"
    value: "{{testEmail}}"

  - type: input
    target:
      css: "input[type='password'], input[name='password'], #password"
    value: "{{testPassword}}"

  - type: tap
    target:
      css: "button[type='submit'], .login-button"

  - type: wait
    timeout: 3000

  - type: screenshot
    name: media-${browser}-after-login.png

  # Navigate to messages
  - type: navigate
    value: /messages

  - type: wait
    timeout: 2000

  - type: screenshot
    name: media-${browser}-start.png

  # Look for media upload button
  - type: tap
    target:
      css: ".media-button, .upload-button, [data-testid='media-upload'], .attach-button"
    optional: true

  - type: wait
    timeout: 1000

  - type: screenshot
    name: media-${browser}-upload-dialog.png
`,

    smoke: `name: Smoke Test (${browser})
platform: web

config:
  web:
    baseUrl: ${baseUrl}
    headless: false

variables:
  testEmail: ${creds.email}
  testPassword: ${creds.password}

steps:
  # ===== PUBLIC PAGES =====
  - type: navigate
    value: /

  - type: wait
    timeout: 2000

  - type: screenshot
    name: smoke-${browser}-01-home.png

  - type: navigate
    value: /login

  - type: wait
    timeout: 1500

  - type: screenshot
    name: smoke-${browser}-02-login.png

  - type: navigate
    value: /signup

  - type: wait
    timeout: 1500

  - type: screenshot
    name: smoke-${browser}-03-signup.png

  - type: navigate
    value: /terms

  - type: wait
    timeout: 1500

  - type: screenshot
    name: smoke-${browser}-04-terms.png

  - type: navigate
    value: /privacy

  - type: wait
    timeout: 1500

  - type: screenshot
    name: smoke-${browser}-05-privacy.png

  - type: navigate
    value: /creators

  - type: wait
    timeout: 1500

  - type: screenshot
    name: smoke-${browser}-06-creators.png

  # ===== LOGIN =====
  - type: navigate
    value: /login

  - type: wait
    timeout: 1500

  - type: input
    target:
      css: "input[type='email'], input[name='email'], #email"
    value: "{{testEmail}}"

  - type: input
    target:
      css: "input[type='password'], input[name='password'], #password"
    value: "{{testPassword}}"

  - type: tap
    target:
      css: "button[type='submit'], .login-button"

  - type: wait
    timeout: 3000

  - type: screenshot
    name: smoke-${browser}-07-after-login.png

  # ===== AUTHENTICATED PAGES =====
  - type: navigate
    value: /profile

  - type: wait
    timeout: 1500

  - type: screenshot
    name: smoke-${browser}-08-profile.png

  - type: navigate
    value: /settings

  - type: wait
    timeout: 1500

  - type: screenshot
    name: smoke-${browser}-09-settings.png

  - type: navigate
    value: /messages

  - type: wait
    timeout: 1500

  - type: screenshot
    name: smoke-${browser}-10-messages.png

  - type: navigate
    value: /checkout

  - type: wait
    timeout: 1500

  - type: screenshot
    name: smoke-${browser}-11-checkout.png

  - type: navigate
    value: /subscriptions

  - type: wait
    timeout: 1500

  - type: screenshot
    name: smoke-${browser}-12-subscriptions.png

  - type: navigate
    value: /feed

  - type: wait
    timeout: 1500

  - type: screenshot
    name: smoke-${browser}-13-feed.png

  - type: navigate
    value: /discover

  - type: wait
    timeout: 1500

  - type: screenshot
    name: smoke-${browser}-14-discover.png

  - type: navigate
    value: /notifications

  - type: wait
    timeout: 1500

  - type: screenshot
    name: smoke-${browser}-15-notifications.png

  - type: navigate
    value: /wallet

  - type: wait
    timeout: 1500

  - type: screenshot
    name: smoke-${browser}-16-wallet.png

  - type: navigate
    value: /admin

  - type: wait
    timeout: 1500

  - type: screenshot
    name: smoke-${browser}-17-admin.png

  - type: navigate
    value: /admin/agencies

  - type: wait
    timeout: 1500

  - type: screenshot
    name: smoke-${browser}-18-admin-agencies.png

  - type: navigate
    value: /admin/creators

  - type: wait
    timeout: 1500

  - type: screenshot
    name: smoke-${browser}-19-admin-creators.png
`,

    profile: `name: Profile Test (${browser})
platform: web

config:
  web:
    baseUrl: ${baseUrl}
    headless: false

variables:
  testEmail: ${creds.email}
  testPassword: ${creds.password}

steps:
  # Login first
  - type: navigate
    value: /login

  - type: wait
    timeout: 2000

  - type: input
    target:
      css: "input[type='email'], input[name='email'], #email"
    value: "{{testEmail}}"

  - type: input
    target:
      css: "input[type='password'], input[name='password'], #password"
    value: "{{testPassword}}"

  - type: tap
    target:
      css: "button[type='submit'], .login-button"

  - type: wait
    timeout: 3000

  - type: screenshot
    name: profile-${browser}-after-login.png

  # Navigate to profile
  - type: navigate
    value: /profile

  - type: wait
    timeout: 2000

  - type: screenshot
    name: profile-${browser}-main.png

  # Check for profile elements
  - type: assert
    target:
      css: "body"

  - type: screenshot
    name: profile-${browser}-content.png
`,

    checkout: `name: Checkout Test (${browser})
platform: web

config:
  web:
    baseUrl: ${baseUrl}
    headless: false

variables:
  testEmail: ${creds.email}
  testPassword: ${creds.password}

steps:
  # Login first
  - type: navigate
    value: /login

  - type: wait
    timeout: 2000

  - type: input
    target:
      css: "input[type='email'], input[name='email'], #email"
    value: "{{testEmail}}"

  - type: input
    target:
      css: "input[type='password'], input[name='password'], #password"
    value: "{{testPassword}}"

  - type: tap
    target:
      css: "button[type='submit'], .login-button"

  - type: wait
    timeout: 3000

  - type: screenshot
    name: checkout-${browser}-after-login.png

  # Navigate to checkout
  - type: navigate
    value: /checkout

  - type: wait
    timeout: 2000

  - type: screenshot
    name: checkout-${browser}-main.png

  # Navigate to subscriptions
  - type: navigate
    value: /subscriptions

  - type: wait
    timeout: 2000

  - type: screenshot
    name: checkout-${browser}-subscriptions.png

  # Navigate to wallet
  - type: navigate
    value: /wallet

  - type: wait
    timeout: 2000

  - type: screenshot
    name: checkout-${browser}-wallet.png
`,

    settings: `name: Settings Test (${browser})
platform: web

config:
  web:
    baseUrl: ${baseUrl}
    headless: false

variables:
  testEmail: ${creds.email}
  testPassword: ${creds.password}

steps:
  # Login first
  - type: navigate
    value: /login

  - type: wait
    timeout: 2000

  - type: input
    target:
      css: "input[type='email'], input[name='email'], #email"
    value: "{{testEmail}}"

  - type: input
    target:
      css: "input[type='password'], input[name='password'], #password"
    value: "{{testPassword}}"

  - type: tap
    target:
      css: "button[type='submit'], .login-button"

  - type: wait
    timeout: 3000

  - type: screenshot
    name: settings-${browser}-after-login.png

  # Navigate to settings
  - type: navigate
    value: /settings

  - type: wait
    timeout: 2000

  - type: screenshot
    name: settings-${browser}-main.png

  # Navigate to notifications
  - type: navigate
    value: /notifications

  - type: wait
    timeout: 2000

  - type: screenshot
    name: settings-${browser}-notifications.png

  # Navigate to profile to test settings
  - type: navigate
    value: /profile

  - type: wait
    timeout: 2000

  - type: screenshot
    name: settings-${browser}-profile.png
`,

    admin: `name: Admin Dashboard Test (${browser})
platform: web

config:
  web:
    baseUrl: ${baseUrl}
    headless: false

variables:
  adminEmail: ${CREDENTIALS.creator.email}
  adminPassword: ${CREDENTIALS.creator.password}

steps:
  # Login as admin/creator
  - type: navigate
    value: /login

  - type: wait
    timeout: 2000

  - type: input
    target:
      css: "input[type='email'], input[name='email'], #email"
    value: "{{adminEmail}}"

  - type: input
    target:
      css: "input[type='password'], input[name='password'], #password"
    value: "{{adminPassword}}"

  - type: tap
    target:
      css: "button[type='submit'], .login-button"

  - type: wait
    timeout: 3000

  - type: screenshot
    name: admin-${browser}-after-login.png

  # Navigate to admin dashboard
  - type: navigate
    value: /admin

  - type: wait
    timeout: 2000

  - type: screenshot
    name: admin-${browser}-dashboard.png

  # Navigate to agencies
  - type: navigate
    value: /admin/agencies

  - type: wait
    timeout: 2000

  - type: screenshot
    name: admin-${browser}-agencies.png

  # Navigate to creators
  - type: navigate
    value: /admin/creators

  - type: wait
    timeout: 2000

  - type: screenshot
    name: admin-${browser}-creators.png

  # Navigate to users
  - type: navigate
    value: /admin/users

  - type: wait
    timeout: 2000

  - type: screenshot
    name: admin-${browser}-users.png

  # Navigate to posts
  - type: navigate
    value: /admin/posts

  - type: wait
    timeout: 2000

  - type: screenshot
    name: admin-${browser}-posts.png
`,
  };

  return tests[scenario] || tests.smoke;
}

function broadcast(message: object) {
  const data = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// Create HTTP server and WebSocket server
const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'connected', message: 'Connected to Intellyo' }));

  ws.on('close', () => {
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║          Intellyo Test Runner             ║
║                                           ║
║   🚀 Server running at:                   ║
║   http://localhost:${PORT}                   ║
║                                           ║
║   Open in browser to start testing        ║
╚═══════════════════════════════════════════╝
  `);
});
