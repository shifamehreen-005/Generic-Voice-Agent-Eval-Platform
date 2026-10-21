// ============================================================================
// demo/adapters/index.ts — registers the two EXAMPLE adapters that ship with
// the platform, so you have something working to read and run. Your own
// adapters live in the top-level /adapters folder, not here.
//
// Each import runs the adapter file, which calls register(...) to add itself.
// The platform then finds an adapter by the "adapter" field in each case file.
// ============================================================================
import "./dental/adapter.ts";        // charts teeth from dictation (no spoken reply)
import "./receptionist/adapter.ts";  // books/reschedules + a spoken reply that is judged
import "./form/adapter.ts";          // streaming form: fields arrive one segment at a time
import "./brief/adapter.ts";         // sectioned document judged in code + quotes
