import type { SemanticInitProject } from "../../../src/vnext/ir.js";

export const HELLO_REQUEST = "Create a Node.js command-line program named `hello`. Running `hello <name>` prints `Hello, <name>!` to standard output and exits with code 0. Running `hello` with no argument prints `Hello, world!` and exits with code 0. Include automated tests.";

/** This fixture is semantic authority only: no machine IDs, hashes, timestamps, or artifact paths. */
export const HELLO_SEMANTIC_FIXTURE: SemanticInitProject = {
  workflow: "init",
  project: {
    name: "hello",
    objective: "Provide a Node.js command-line greeting program with deterministic named and default output, covered by automated tests.",
  },
  determinations: [
    {
      key: "node-cli",
      statement: "The product is a Node.js command-line program named hello.",
      rationale: "The requested runtime and product surface are explicit.",
      materiality: "architecture",
      rigidity: "RIGID",
      source: { kind: "request", evidence: "Node.js command-line program named `hello`" },
    },
    {
      key: "automated-tests",
      statement: "The implementation includes automated tests.",
      rationale: "Automated regression coverage is explicitly requested.",
      materiality: "implementation",
      rigidity: "RIGID",
      source: { kind: "request", evidence: "Include automated tests." },
    },
    {
      key: "minimal-layout",
      statement: "Use a small source, binary, and test layout.",
      rationale: "No larger project structure is required for this greenfield CLI.",
      materiality: "implementation",
      rigidity: "FLEXIBLE",
      source: { kind: "model-default" },
    },
  ],
  requirements: [
    { key: "greet-named-user", statement: "Running hello with a name writes exactly `Hello, <name>!` to standard output and exits with code 0." },
    { key: "greet-default-user", statement: "Running hello with no argument writes exactly `Hello, world!` to standard output and exits with code 0." },
    { key: "ship-cli", statement: "The package exposes an executable command named `hello`." },
    { key: "automated-coverage", statement: "Automated tests cover the named and default greeting behavior." },
  ],
  qualityCommands: [
    { key: "run-tests", kind: "test", command: "npm test" },
  ],
  protectedPaths: [],
  phases: [
    {
      key: "deliver-cli",
      title: "Deliver the hello CLI",
      goal: "Users can install and run the hello command with tested named and default greetings.",
      dependsOn: [],
      tasks: [
        {
          key: "setup-cli",
          title: "Create the Node package and executable",
          intent: "Create the package metadata, executable command, and greeting module boundary.",
          dependsOn: [],
          ownedPaths: ["package.json", "bin/hello.js", "src/greet.js"],
          covers: ["ship-cli"],
          acceptance: [
            "Running `node bin/hello.js Ada` exits with code 0 and invokes the greeting implementation.",
          ],
          validation: [{ kind: "command", commandKey: "run-tests" }],
          expectedEvidence: "Package metadata, executable source, greeting source, and passing test output.",
        },
        {
          key: "verify-greetings",
          title: "Implement and test greeting behavior",
          intent: "Implement exact named and default greetings and cover both outcomes with automated tests.",
          dependsOn: ["setup-cli"],
          ownedPaths: ["src/greet.js", "test/greet.test.js"],
          covers: ["greet-named-user", "greet-default-user", "automated-coverage"],
          acceptance: [
            "Running `node bin/hello.js Ada` writes exactly `Hello, Ada!` to standard output and exits with code 0.",
            "Running `node bin/hello.js` with no argument writes exactly `Hello, world!` to standard output and exits with code 0.",
            "Running `npm test` completes with passing automated checks for both greeting cases.",
          ],
          validation: [{ kind: "command", commandKey: "run-tests" }],
          expectedEvidence: "Greeting implementation, automated test source, and passing npm test output.",
        },
      ],
    },
  ],
};

