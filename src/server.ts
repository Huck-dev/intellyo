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

// AI-powered test suite generation
app.post('/api/generate-suite', async (req, res) => {
  const { description, projectName, baseUrl, provider, apiKey, model } = req.body;

  broadcast({ type: 'status', message: `Generating test suite for "${projectName}"...` });

  try {
    const fs = await import('fs/promises');

    // Create project test directory
    const projectTestDir = `${serverSettings.testDir}/${projectName}`;
    await fs.mkdir(projectTestDir, { recursive: true });

    // Use AI to analyze description and generate tests
    const tests = await generateTestsWithAI(description, projectName, baseUrl, provider || serverSettings.provider, apiKey || serverSettings.apiKey, model || serverSettings.model);

    // Write each test file
    let testsCreated = 0;
    for (const test of tests) {
      const testPath = `${projectTestDir}/${test.name}.test.yaml`;
      await fs.writeFile(testPath, test.content);
      broadcast({ type: 'output', message: `Created: ${test.name}.test.yaml` });
      testsCreated++;
    }

    broadcast({ type: 'success', message: `Generated ${testsCreated} tests for ${projectName}` });
    res.json({ success: true, testsCreated, directory: projectTestDir });
  } catch (error: any) {
    broadcast({ type: 'error', message: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Generate tests using AI (Ollama or cloud providers)
async function generateTestsWithAI(
  description: string,
  projectName: string,
  baseUrl: string,
  provider: string,
  apiKey: string,
  model: string
): Promise<Array<{ name: string; content: string }>> {

  const prompt = `You are a test automation expert. Based on this app description, generate a list of test scenarios as JSON.

App Description: ${description}
Base URL: ${baseUrl}

Return ONLY a JSON array of test objects. Each object should have:
- "name": short test name (kebab-case, e.g., "user-login", "send-message")
- "description": what the test does
- "steps": array of test steps, each with "type" and relevant fields

Step types available:
- navigate: { type: "navigate", value: "/path" }
- wait: { type: "wait", timeout: 2000 }
- input: { type: "input", target: { css: "selector" }, value: "text" }
- tap: { type: "tap", target: { css: "selector" } }
- screenshot: { type: "screenshot", name: "filename.png" }
- assert: { type: "assert", target: { css: "selector" } }

Example response:
[
  {
    "name": "user-login",
    "description": "Test user login flow",
    "steps": [
      { "type": "navigate", "value": "/login" },
      { "type": "wait", "timeout": 2000 },
      { "type": "input", "target": { "css": "input[type='email']" }, "value": "test@example.com" },
      { "type": "input", "target": { "css": "input[type='password']" }, "value": "password123" },
      { "type": "tap", "target": { "css": "button[type='submit']" } },
      { "type": "wait", "timeout": 3000 },
      { "type": "screenshot", "name": "login-result.png" }
    ]
  }
]

Generate 3-8 relevant tests based on the app description. Return ONLY valid JSON, no markdown.`;

  let aiResponse: string;

  if (provider === 'ollama') {
    // Use Ollama
    const ollamaModel = model || 'qwen2.5-coder:7b';
    const ollamaRes = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        prompt,
        stream: false
      })
    });
    const ollamaData = await ollamaRes.json();
    aiResponse = ollamaData.response;
  } else if (provider === 'openai' && apiKey) {
    // Use OpenAI
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7
      })
    });
    const openaiData = await openaiRes.json();
    aiResponse = openaiData.choices?.[0]?.message?.content || '';
  } else if (provider === 'anthropic' && apiKey) {
    // Use Anthropic
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || 'claude-3-haiku-20240307',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const anthropicData = await anthropicRes.json();
    aiResponse = anthropicData.content?.[0]?.text || '';
  } else {
    // Fallback: generate basic tests from description keywords
    return generateFallbackTests(description, projectName, baseUrl);
  }

  // Parse AI response
  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      broadcast({ type: 'output', message: 'AI response did not contain valid JSON, using fallback' });
      return generateFallbackTests(description, projectName, baseUrl);
    }

    const testSpecs = JSON.parse(jsonMatch[0]);

    // Convert to YAML test files
    return testSpecs.map((spec: any) => ({
      name: spec.name,
      content: generateYamlFromSpec(spec, projectName, baseUrl)
    }));
  } catch (e) {
    broadcast({ type: 'output', message: 'Failed to parse AI response, using fallback' });
    return generateFallbackTests(description, projectName, baseUrl);
  }
}

// Generate YAML from AI spec
function generateYamlFromSpec(spec: any, projectName: string, baseUrl: string): string {
  let yaml = `name: ${spec.description || spec.name}
platform: web

config:
  web:
    baseUrl: ${baseUrl}
    headless: false

steps:
`;

  for (const step of spec.steps) {
    if (step.type === 'navigate') {
      yaml += `  - type: navigate
    value: ${step.value}

`;
    } else if (step.type === 'wait') {
      yaml += `  - type: wait
    timeout: ${step.timeout || 2000}

`;
    } else if (step.type === 'input') {
      yaml += `  - type: input
    target:
      css: "${step.target?.css || 'input'}"
    value: "${step.value || ''}"

`;
    } else if (step.type === 'tap') {
      yaml += `  - type: tap
    target:
      css: "${step.target?.css || 'button'}"

`;
    } else if (step.type === 'screenshot') {
      yaml += `  - type: screenshot
    name: ${step.name || 'screenshot.png'}

`;
    } else if (step.type === 'assert') {
      yaml += `  - type: assert
    target:
      css: "${step.target?.css || 'body'}"

`;
    }
  }

  return yaml;
}

// Fallback test generation without AI
function generateFallbackTests(description: string, projectName: string, baseUrl: string): Array<{ name: string; content: string }> {
  const tests: Array<{ name: string; content: string }> = [];
  const desc = description.toLowerCase();

  // Always add a smoke test
  tests.push({
    name: 'smoke-test',
    content: `name: Smoke Test
platform: web

config:
  web:
    baseUrl: ${baseUrl}
    headless: false

steps:
  - type: navigate
    value: /

  - type: wait
    timeout: 2000

  - type: screenshot
    name: ${projectName}-home.png

  - type: assert
    target:
      css: "body"
`
  });

  // Add login test if mentioned
  if (desc.includes('login') || desc.includes('auth') || desc.includes('sign in')) {
    tests.push({
      name: 'login-flow',
      content: `name: Login Flow Test
platform: web

config:
  web:
    baseUrl: ${baseUrl}
    headless: false

steps:
  - type: navigate
    value: /login

  - type: wait
    timeout: 2000

  - type: input
    target:
      css: "input[type='email'], input[name='email']"
    value: "test@example.com"

  - type: input
    target:
      css: "input[type='password'], input[name='password']"
    value: "password123"

  - type: tap
    target:
      css: "button[type='submit']"

  - type: wait
    timeout: 3000

  - type: screenshot
    name: ${projectName}-login-result.png
`
    });
  }

  // Add signup test if mentioned
  if (desc.includes('signup') || desc.includes('register') || desc.includes('sign up')) {
    tests.push({
      name: 'signup-flow',
      content: `name: Signup Flow Test
platform: web

config:
  web:
    baseUrl: ${baseUrl}
    headless: false

steps:
  - type: navigate
    value: /signup

  - type: wait
    timeout: 2000

  - type: screenshot
    name: ${projectName}-signup-page.png

  - type: input
    target:
      css: "input[type='email'], input[name='email']"
    value: "newuser@example.com"

  - type: input
    target:
      css: "input[type='password'], input[name='password']"
    value: "password123"

  - type: tap
    target:
      css: "button[type='submit']"

  - type: wait
    timeout: 3000

  - type: screenshot
    name: ${projectName}-signup-result.png
`
    });
  }

  // Add messaging test if mentioned
  if (desc.includes('message') || desc.includes('chat') || desc.includes('messaging')) {
    tests.push({
      name: 'messaging',
      content: `name: Messaging Test
platform: web

config:
  web:
    baseUrl: ${baseUrl}
    headless: false

steps:
  - type: navigate
    value: /messages

  - type: wait
    timeout: 2000

  - type: screenshot
    name: ${projectName}-messages.png
`
    });
  }

  // Add profile test if mentioned
  if (desc.includes('profile') || desc.includes('user')) {
    tests.push({
      name: 'user-profile',
      content: `name: User Profile Test
platform: web

config:
  web:
    baseUrl: ${baseUrl}
    headless: false

steps:
  - type: navigate
    value: /profile

  - type: wait
    timeout: 2000

  - type: screenshot
    name: ${projectName}-profile.png
`
    });
  }

  return tests;
}

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
