# TurboWarp Plus Editor Test

[日本語](README.ja.md)

Runs the tests written inside a TurboWarp Plus Editor project with the [TurboWarp-Test](https://github.com/kubohiroya/turbowarp-test) blocks. Every test starts from a fresh copy of the project on a VM of its own, so the editor's project, undo history and selection are never touched, and no test sees what another left behind. Results come back per test, with the check block that failed, and as JUnit XML for CI. This package types the VM structurally and imports no VM, GUI, React or Dockview.

Design: [turbowarp-plus-editor#774](https://github.com/kubohiroya/turbowarp-plus-editor/issues/774).

## Entry points

| Import | Contents |
| --- | --- |
| `@kubohiroya/turbowarp-plus-editor-test/test-discovery` | `discoverTests(project)`: the tests in a `project.json`, addressed as `<target>/<block ID>`, with each target's "before each test" hat and the targets that have more than one |
| `@kubohiroya/turbowarp-plus-editor-test/test-runner` | `runTests({vm, project, only, frameLimit, signal, onTestStart, onTestEnd})`: runs the tests and returns a report |
| `@kubohiroya/turbowarp-plus-editor-test/test-run-view` | `createTestRunView(options)`: the test run view, plain DOM. `testRunMenuItem(locale, open)`: the item for the workbench's run view ▼ menu (`menuItems`). `testRunPanelRequest(options)`: the view as a transient workspace tab, for the workbench's `getDocumentWorkspace(vm).open()` |
| `@kubohiroya/turbowarp-plus-editor-test/junit` | `toJUnitXml(report)`: one suite per sprite or stage, one case per test |
| `@kubohiroya/turbowarp-plus-editor-test` | All of the above, and the extension's protocol constants |

## How a test runs

1. The runner loads a fresh copy of the project into its VM, with the compiler off: the extension's waits check their condition again in each frame only in the interpreter.
2. If the test's sprite or stage has a "before each test" hat, that script runs to its end.
3. The test script runs, one frame per `runtime._step()`, until it ends or reaches `frameLimit` frames (3000 by default).
4. The runner keeps the records the extension emits for these two scripts and stops every thread.

A test **passed** when its script ended with no failed check, **failed** when a check failed, **timed out** when it ran out of frames, and is an **error** when it could not run: its target has two "before each test" hats, or a block threw. The green flag is never pressed.

## The test run view

The view shows a stage of its own, the project's tests and their results. **Run all** and each test's **Run** button start a run; **Stop** ends it. A failed check shows what it compared, and **Show block** asks the host to show that block in the editor. A test that timed out or could not run shows why. The view lists the tests as soon as it opens, and creates the test VM only when a run starts. Its text is Japanese or English, following `locale`.

The host passes `getProject()`, which returns a copy of the editor's project when a run starts, `createVm(stage)`, which creates the test VM and draws its stage into `stage`, and optionally `showBlock(target, blockId)`.

## What the host provides

- A VM the runner drives alone, with its frame loop stopped (`vm.start()` not called). Not the editor's VM.
- The TurboWarp-Test extension loaded in that VM, since the project uses its blocks.
- The project. To mark failures on the editor's blocks, pass `editorVm.toJSON(undefined, {allowOptimization: false})`: TurboWarp's default serialization renumbers block IDs, and then the IDs in the records would not match the editor's blocks. Attach the editor's storage to the test VM so that the assets load without a download.

Frames are runtime steps, not wall-clock time. A loop with no visual change can run more than once per frame, as it does in TurboWarp, so count frames with the extension's waits rather than by such loops.

## Verification

`npm test` builds the package and runs the unit tests. `npm run test:browser` runs the runner on the Editor's pinned VM (`@kubohiroya/turbowarp-plus-editor-test-runtime`) in headless Chromium. CI runs both.

## License

MPL-2.0.
