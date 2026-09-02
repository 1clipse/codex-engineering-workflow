# Runtime Flows

1. A thin host entrypoint reads the canonical JSON contract, gathers the minimum semantic context, and starts or resumes a flow.
2. Delivery Control pins the flow to a policy identity, version and digest; it selects `standard` by default or escalates to `strict` when the declared risk requires it.
3. Delivery Control projects revisioned controlled state into the selected Plan Tree target. Human-authored Plan Tree prose remains outside the controller's drift boundary.
4. High-level operations checkpoint scope and phase changes, bind evidence and reviews to the active delivery generation, and require exact authorization for controlled external actions.
5. Native `/plan` or `/goal` projections and optional host Hooks improve runtime ergonomics only. A missing host feature creates a handoff or diagnostic, never a false completion block.
6. Close succeeds only when the policy's current evidence, review, authorization and observable terminal-condition gates pass. It does not rely on native-plan synchronization.
