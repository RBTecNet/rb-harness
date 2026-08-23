#!/usr/bin/env node

for await (const _chunk of process.stdin) {
  // Consume the complete stdin contract before returning the fixture failure.
}
process.stderr.write(`fixture failure ${process.env.RB_HARNESS_TEST_API_KEY ?? "missing"}\n`);
process.exit(9);
