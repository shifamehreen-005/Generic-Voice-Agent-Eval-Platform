// ============================================================================
// adapters/index.ts — YOUR adapters. This is where you plug in your own agent.
//
// One line per adapter. Each import runs the adapter file, which registers
// itself with the platform. To add your agent:
//
//   1. copy sample-agent.ts to  adapters/<your-name>.ts
//   2. fill in run / fold / score (see the comments in sample-agent.ts)
//   3. add an import line for it below
//   4. write test cases and run  npm run eval -- run --cases <your-cases>
//
// (The two ready-made EXAMPLE agents — dental and receptionist — live under
//  demo/adapters and are registered separately, so you can read working code.)
// ============================================================================
import "./sample-agent.ts";
import "./fixture-agent.ts";
import "./hardfail.ts";
