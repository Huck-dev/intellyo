# Intellyo

AI-powered test runner GUI for web applications. Generate and execute automated browser tests with a simple web interface.

## Features

- **Quick Test Generation**: Select a test scenario and browser, click to generate and run
- **Multiple Browsers**: Chrome, Firefox, and Safari support via Playwright
- **Real-time Output**: WebSocket-powered live test output streaming
- **Test Library**: Browse and run existing YAML test files
- **AI Integration**: Use local Ollama models or cloud API for test generation
- **Credential Management**: Built-in support for test user credentials

## Requirements

- Node.js 18+
- pnpm (or npm/yarn)
- [IntelliTester](https://www.npmjs.com/package/intellitester) CLI
- Playwright browsers installed
- (Optional) [Ollama](https://ollama.ai) for local AI models

## Installation

```bash
# Clone the repository
git clone https://github.com/server9-dev/intellyo.git
cd intellyo

# Install dependencies
pnpm install

# Build the project
pnpm build

# Install IntelliTester globally
npm install -g intellitester

# Install Playwright browsers
npx playwright install chromium firefox webkit
npx playwright install-deps
```

## Quick Start

```bash
# Start the server
pnpm start

# Or for development with auto-rebuild
pnpm dev
```

Open http://localhost:4445 in your browser.

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```env
# Optional: API key for cloud AI providers
INTELLYO_API_KEY=your-api-key-here

# Test directory (default: ../intellitester-tests)
TEST_DIR=/path/to/your/tests
```

### Test Credentials

Default test credentials can be configured in `src/server.ts`:

```typescript
const CREDENTIALS = {
  user: { email: 'user@test.com', password: 'password123' },
  creator: { email: 'creator@test.com', password: 'password123' }
};
```

## Usage

### Quick Run (Generate & Run)

1. Select a test type (Login, Signup, Smoke Test, etc.)
2. Choose your browser (Chrome, Firefox, Safari)
3. Set the base URL for your application
4. Toggle "Show browser window" for visible testing
5. Click "Generate & Run"

### Existing Tests

1. Browse the test list in the "Existing Tests" panel
2. Use the search box to filter tests
3. Select a test and click "Run Selected Test"

## Test Scenarios

| Scenario | Description |
|----------|-------------|
| Login Flow | Test user authentication |
| Signup Flow | Test user registration |
| Send Message | Test messaging functionality |
| Send Media | Test file/media uploads |
| View Profile | Test user profile pages |
| Checkout | Test purchase flow |
| Settings | Test user settings pages |
| Admin Dashboard | Test admin functionality |
| Smoke Test | Quick test of all major pages |

## YAML Test Format

Tests are written in YAML format compatible with IntelliTester:

```yaml
name: My Test
platform: web

config:
  web:
    baseUrl: http://localhost:3000
    headless: false

variables:
  testEmail: user@test.com
  testPassword: password123

steps:
  - type: navigate
    value: /login

  - type: input
    target:
      css: "input[type='email']"
    value: "{{testEmail}}"

  - type: tap
    target:
      css: "button[type='submit']"

  - type: screenshot
    name: result.png
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/scenarios` | GET | List available test scenarios |
| `/api/tests` | GET | List existing test files |
| `/api/browsers` | GET | List available browsers |
| `/api/models` | GET | List available Ollama models |
| `/api/generate` | POST | Generate a new test |
| `/api/run` | POST | Run a test file |

## Development

```bash
# Install dependencies
pnpm install

# Run in development mode (watches for changes)
pnpm dev

# Build for production
pnpm build

# Start production server
pnpm start

# Type check
pnpm typecheck
```

## Project Structure

```
intellyo/
├── src/
│   └── server.ts      # Express server with WebSocket support
├── public/
│   └── index.html     # Frontend UI
├── dist/              # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
└── README.md
```

## Troubleshooting

### Browser not found
```bash
# Install Playwright browsers
npx playwright install chromium firefox webkit
npx playwright install-deps
```

### Port already in use
```bash
# Kill process on port 4445
fuser -k 4445/tcp
```

### Ollama not available
The app works without Ollama - test generation uses predefined templates. For AI-powered generation, install Ollama and pull a model:
```bash
ollama pull qwen2.5-coder:7b
```

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.
