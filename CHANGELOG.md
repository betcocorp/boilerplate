# [3.0.0](https://github.com/betcocorp/bex2.0/compare/v2.19.0...v3.0.0) (2026-09-03)


* feat(B0-746)!: split the floor SME agent into four substrate specialists ([e114460](https://github.com/betcocorp/bex2.0/commit/e114460cbc7bce10710a0af496b1414afe1e4685))
* feat(B0-813,B0-812,B0-815,B0-809)!: pure-math report scoring on the golden concept columns ([b8d7663](https://github.com/betcocorp/bex2.0/commit/b8d7663e0085a0637754b2cd0e2adea5d7663f59))
* fix(B0-757)!: move generation model default and lock thresholds to settings, show resolved model ([870fac9](https://github.com/betcocorp/bex2.0/commit/870fac909019b53b31fb8b02922ba5008fdeda1f))


### Bug Fixes

* **B0-413:** restore bex.chat.use permission row and document cutover NO-GO ([301506e](https://github.com/betcocorp/bex2.0/commit/301506ed25daabe6171bdbc5fdc68fea4a15c9a0))
* **B0-413:** tell users with no grants the truth instead of "try signing in again" ([1191282](https://github.com/betcocorp/bex2.0/commit/11912828cf98b7771ec241ca00ec09dce84cc9b1))
* **B0-636:** resolve FastDraw dilution chunks to the product-line entity tier ([04c8b87](https://github.com/betcocorp/bex2.0/commit/04c8b8773d81d359cb61a500d0dde27b109e1942))
* **B0-655:** stop test-runner import from leaving a phantom empty set ([1f86948](https://github.com/betcocorp/bex2.0/commit/1f86948f5e602862b04ebad1866ef27d3248a9b6))
* **B0-693:** require corroboration for general-query product-line locks, surface failed runs ([c95c287](https://github.com/betcocorp/bex2.0/commit/c95c287453025fbebf8e5e139cea111227ecbb37))
* **B0-700:** deterministically disclose fuzzy-alias product corrections ([53deee1](https://github.com/betcocorp/bex2.0/commit/53deee1100daca1e62790a66883e9334d1665849))
* **B0-755:** grade decline correctness semantically, not by phrase match ([b8cadd2](https://github.com/betcocorp/bex2.0/commit/b8cadd263125edd992fd1d9f2b02aa2f5b3d6242))
* **B0-756,B0-700:** add compatibility to the regulated-claim guardrail; disclose fuzzy product matches ([aae42b3](https://github.com/betcocorp/bex2.0/commit/aae42b3b3084ff3f5b30fff13fbba82a02cd5ebe))
* **B0-756:** audit and close remaining gaps in the regulated-claim guardrail ([b759ff5](https://github.com/betcocorp/bex2.0/commit/b759ff51c64f9c0481f050ad6d741ede82f371a3))
* **B0-756:** split confidence gating so non-predictive recommendation caps stay off ([6317503](https://github.com/betcocorp/bex2.0/commit/6317503a8ade4d2b0559012afdab7f2b3ecd8ed1))
* **B0-779:** guard cross-reference match template against unresolved competitor identity ([826747b](https://github.com/betcocorp/bex2.0/commit/826747b000f3c273d8ede4ec746463cd5f58d180))
* **B0-780:** bind knowledge retrieval to product category (wood/VCT/restroom) ([f0e76a5](https://github.com/betcocorp/bex2.0/commit/f0e76a5d1f4d912f80a761758dfc926aa408ce89))
* **B0-781:** extend enumeration-question detection in classifyRetrievalIntent ([45d6669](https://github.com/betcocorp/bex2.0/commit/45d66694292c97662f4ad9cb86171e29600643d5))
* **B0-782:** add never-assert-past-the-evidence rule to product and bathroom prompts ([a91b13c](https://github.com/betcocorp/bex2.0/commit/a91b13c996694bbdeb8e487e85d96458f349320a))
* **B0-783:** defer to a Betco rep unconditionally, forbid a single-product closing summary ([df5bcba](https://github.com/betcocorp/bex2.0/commit/df5bcbae9e8d6ed8a2d96a067e48999dd531b98e))
* **B0-783:** detect selection-framing questions, lead with criteria not one product ([32fb318](https://github.com/betcocorp/bex2.0/commit/32fb3182ef2dfcb86bf3f7f8b9507c48d7d3d4f0))
* **B0-783:** forbid product-first framing entirely, require a named rep deferral ([b59e682](https://github.com/betcocorp/bex2.0/commit/b59e682fd8f15ef00d7c79dff6287e11cec617b8))
* **B0-784:** give a concrete required phrasing for a partial-evidence multi-part answer ([d4a301a](https://github.com/betcocorp/bex2.0/commit/d4a301a60c9788a2e2c47b8ce38649f52463d654))
* **B0-784:** make multi-part and near-miss questions complete their whole answer ([a8f249e](https://github.com/betcocorp/bex2.0/commit/a8f249ec5a1144f7a60c8655957050816afd0b46))
* **B0-784:** require per-part retrieved evidence, forbid extending one part's proof to another ([445a32d](https://github.com/betcocorp/bex2.0/commit/445a32dfe001a7e2fcbd36d93b78e9bdc2340f70))
* **B0-784:** widen retrieval for compound-subject verification questions ([dcf5a12](https://github.com/betcocorp/bex2.0/commit/dcf5a126b5af151f121a965cf4a1e878de736820))
* **B0-788:** force get_efficacy_data for exact dilution/efficacy/yield questions ([5d0eb68](https://github.com/betcocorp/bex2.0/commit/5d0eb68351e0c84906b85f796c1001ae3520c1fa))
* **B0-791:** exclude EXP- experimental aliases from fuzzy product-name matching ([c8132a7](https://github.com/betcocorp/bex2.0/commit/c8132a7cf2ff47298c68775bbb3cc97a06e3c80a))
* **B0-792,B0-700,B0-756:** pin regulated facts to the resolved product, not its product_line_key group ([9ed111c](https://github.com/betcocorp/bex2.0/commit/9ed111c0fbed7107ac5459d21432981243bc439a))
* **B0-794:** remove 364 content-foreign SDS from the retrievable corpus ([9756164](https://github.com/betcocorp/bex2.0/commit/9756164cfa0681d4f7e5c4d3ed480522716aecb2))
* **B0-795:** make the xref score discriminate — AUC 0.361 -> 0.728 ([6943b90](https://github.com/betcocorp/bex2.0/commit/6943b90306a9572a059abad443fb2f5b8ea4a9fc))
* **B0-796:** reconcile efficacy is_current and stop trusting docs[0] ([f10c410](https://github.com/betcocorp/bex2.0/commit/f10c4108e677cf2c7976b833f549ebc74bce3679))
* **B0-796:** sync efficacy is_current from frontmatter — 55 superseded reports excluded ([80965e3](https://github.com/betcocorp/bex2.0/commit/80965e3569bea820bb8e26fd622297f21c3e312f))
* **B0-804:** make the English-only retrieval corpus enforced, not incidental ([5186a70](https://github.com/betcocorp/bex2.0/commit/5186a70f43fbf306e3157582d1c1f557f2b45c3b))
* **B0-829:** redact only ungrounded regulated tokens instead of declining the whole answer ([0b2b09e](https://github.com/betcocorp/bex2.0/commit/0b2b09e2cf5988c3be4837982abe48c19d36b5db))
* **B0-830:** name the resolved product line correctly and rewrite the misspelled name out of the answer ([2f1be41](https://github.com/betcocorp/bex2.0/commit/2f1be41cf395f9b05f9d265e8283a8de5af27e9f))
* make OrphanRecordDialog span 50% of screen width ([ec83c71](https://github.com/betcocorp/bex2.0/commit/ec83c7146d20addfb9061a44732b2854c4978d2c))


### Features

* **admin:** add last run score column to test runner and update avg score display ([3a4b02a](https://github.com/betcocorp/bex2.0/commit/3a4b02a1dc8a7747c1479b4be24d176ec7a58852))
* **B0-203:** idempotent orphan-SDS backfill, and correct two stale ticket premises ([93d48f3](https://github.com/betcocorp/bex2.0/commit/93d48f3755bceda74429544ce0e6eb6ade6dff85))
* **B0-232:** derive the efficacy crosswalk from live data and link 125 documents ([105ac89](https://github.com/betcocorp/bex2.0/commit/105ac89f78b2f05db58f8862a2c132a1f22f0286))
* **B0-236:** seed 27 efficacy gold eval items and record a baseline ([adec1c8](https://github.com/betcocorp/bex2.0/commit/adec1c85fb4e0bd7f50380c2862ae8e92b58ef87))
* **B0-636:** add FastDraw dilution ingestion, tool exposure, and golden eval coverage ([a99f2d5](https://github.com/betcocorp/bex2.0/commit/a99f2d5fbb6f35bc85f3474b145f1cbc182b138d))
* **B0-765:** force GPT-5.6 Sol for run-report grading via settings row ([aa508dc](https://github.com/betcocorp/bex2.0/commit/aa508dc0f8f8dc1e814923d2d0724078df7a871f))
* **B0-786:** consolidate prompt signal detection into one pre-orchestration call ([ab090d8](https://github.com/betcocorp/bex2.0/commit/ab090d80e59581b9caa8f7edda544fe6db40163b))
* **B0-786:** move router model/timeout to settings and add signals rollout flag ([e873f75](https://github.com/betcocorp/bex2.0/commit/e873f756f331c53989bb8ccf73d4a8cf95b54aa9))
* **B0-793:** add Score column to observability Workflow runs table ([aae1250](https://github.com/betcocorp/bex2.0/commit/aae12501c445b4f48026fa2d7414aed14164a24e))
* **B0-797:** re-convert the 70 hygiene efficacy PDFs — claim tables recovered ([613bf9e](https://github.com/betcocorp/bex2.0/commit/613bf9eabb4cf2c62d8cd60c656df8a4bbfa6805))
* **B0-804:** hide translated documents in the orphan monitor behind a toggle ([7592dc1](https://github.com/betcocorp/bex2.0/commit/7592dc1f3ab81bc754ec9386a7f42f47e4f6b51a))
* **B0-808,B0-810:** grader judges concept coverage and judged metrics; methodology prompt with content hash ([d19f6c6](https://github.com/betcocorp/bex2.0/commit/d19f6c61b423c6262e1af414759c0151d6610618))
* **B0-811,B0-818,B0-825,B0-816:** judged-metrics rollup, three passes by default, grading config in the report ([a7789f5](https://github.com/betcocorp/bex2.0/commit/a7789f5df1c85c32efa642a4d8b8828a04e9a80e))
* **B0-817,B0-811:** consolidation rules match the reference; judged metrics consolidate by median ([631d5dc](https://github.com/betcocorp/bex2.0/commit/631d5dc3beb910bc93d58ad01767eb610f8566c7))
* **B0-97:** xref gate calibration harness, and evidence that 0.80 is not the problem ([1089ab1](https://github.com/betcocorp/bex2.0/commit/1089ab128b681d03965cf75e0bb4cfbc1dc7fc61))
* **B0-XXX:** add view icon button for trace reports in detailed results ([7cdfbaa](https://github.com/betcocorp/bex2.0/commit/7cdfbaa7f2b11d0b6eeac95f74a1934e92414d17))


### BREAKING CHANGES

* /api/admin/tests/runs/[runId]/report/data — ReportCaseStatus is
'Pass' | 'Fail'; RateBlock drops partial/partialPct; EvaluatedCase drops rubricStatus,
statusSource, ratingConstrained, gateBlockedAPass, autoPassTriggered, autoPassBlocked;
ConceptRollup drops gateBlockedPasses/autoPassed/autoPassBlocked and adds materialIssues;
metrics gains passMark/strictPassMark/passOnlyUnderCurrentMark. Reports generated
before this change re-derive as Unable to Evaluate until regenerated by a grader that
emits concept verdicts (B0-808, next).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
* resolveResponsesModel is now async; all callers must
await it.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
* the single `floor` SME agent id is gone; /api/v1/agents/floor
no longer exists. Replaced by floor_wood_sport, floor_concrete, floor_stg,
and floor_vct -- SportZone/wood-sport, concrete, Stone/Tile/Grout
Cleaner-and-Protectant, and VCT/terrazzo/resilient-tile respectively.
sportszone/vct knowledge-ingest folders now map to their own specific ids
(previously both collapsed onto `floor`); floor_concrete/floor_stg have no
dedicated ingest folder yet, documented as a gap rather than fabricated.
Every SME-id sync point is updated: agent-registry.ts's enum + registry,
confidence-thresholds.ts, run-sme-agent.ts, agent-badge.ts,
endpoints/definitions.ts, sme-routing.ts's per-substrate signal lists and
tie-break order, intent-classifier.ts's routing rules, semantic-router
examples, and product-support-prompts.ts/prompt-version.ts's per-agent
arrays. Applied a companion migration reclassifying existing
routing_test_items/routing_test_run_items rows and widening both tables'
expected_agent CHECK constraints to the new id set (verified live via
Supabase MCP -- shipping the code without it would have broken every
routing-test insert against the old constraint).

B0-745 (Signal Research): investigated whether dedicated prompt-signal
detection (e.g. "dilution ratio" as a metric-intent signal, distinct from
routing) is worth building. Found product lock already exists twice over
-- live today via the freeform alias-resolution path, and more fully in
the B0-786 signals-analysis pipeline, currently disabled pending its own
cost/quality tradeoff. Recommended against building a new, redundant
signal taxonomy on top of the LLM router that's already the default path;
recommended against decoupling/enabling the B0-786 slice until B0-693's
non-regulated-query verification gap (fixed in this same batch) had
landed. No new code shipped for this ticket -- see the Jira comment for
the full write-up.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

# [2.19.0](https://github.com/betcocorp/bex2.0/compare/v2.18.0...v2.19.0) (2026-09-03)


### Bug Fixes

* **B0-413:** restore bex.chat.use permission row and document cutover NO-GO ([da437d8](https://github.com/betcocorp/bex2.0/commit/da437d8c5b512bfec6971925ccde00bf1a9f36c5))
* **B0-413:** tell users with no grants the truth instead of "try signing in again" ([027cf2e](https://github.com/betcocorp/bex2.0/commit/027cf2eaa636b34cf61a9111769767b9c86a259e))
* **B0-636:** resolve FastDraw dilution chunks to the product-line entity tier ([32e8533](https://github.com/betcocorp/bex2.0/commit/32e8533145cf7b803e2e6f1ec64e231bfdbcd8b5))
* **B0-779:** guard cross-reference match template against unresolved competitor identity ([8b44d67](https://github.com/betcocorp/bex2.0/commit/8b44d67dae68605638f531bd50e477b937e3cf98))
* **B0-780:** bind knowledge retrieval to product category (wood/VCT/restroom) ([b79b48b](https://github.com/betcocorp/bex2.0/commit/b79b48b4899e29d34fe5efaa7e74ed7f12cd049e))
* **B0-781:** extend enumeration-question detection in classifyRetrievalIntent ([d86a327](https://github.com/betcocorp/bex2.0/commit/d86a32711093e7c007daab1e1b7f20226b5a5e82))
* **B0-782:** add never-assert-past-the-evidence rule to product and bathroom prompts ([d1fef87](https://github.com/betcocorp/bex2.0/commit/d1fef87359a3d52256324f1840e09dfa9b1b5516))
* **B0-783:** defer to a Betco rep unconditionally, forbid a single-product closing summary ([8f0cd5a](https://github.com/betcocorp/bex2.0/commit/8f0cd5a4c4ccc2a52ab19f86cbf349a588b94558))
* **B0-783:** detect selection-framing questions, lead with criteria not one product ([800e583](https://github.com/betcocorp/bex2.0/commit/800e5831c49aa8a433cf4f1f3f71a2647e0b6392))
* **B0-783:** forbid product-first framing entirely, require a named rep deferral ([74aea42](https://github.com/betcocorp/bex2.0/commit/74aea42c5f2212e94d249d94700543e2a36cb617))
* **B0-784:** give a concrete required phrasing for a partial-evidence multi-part answer ([31100c4](https://github.com/betcocorp/bex2.0/commit/31100c405e9b21ab80b9e8bc6f359de50dec1d94))
* **B0-784:** make multi-part and near-miss questions complete their whole answer ([682f0c3](https://github.com/betcocorp/bex2.0/commit/682f0c31fd0c57ff5592d770c303771d51f3eefb))
* **B0-784:** require per-part retrieved evidence, forbid extending one part's proof to another ([1fd363d](https://github.com/betcocorp/bex2.0/commit/1fd363d9c7d2b10d8fc292c33f875d75348cbe45))
* **B0-784:** widen retrieval for compound-subject verification questions ([87fff1a](https://github.com/betcocorp/bex2.0/commit/87fff1a74d195f72238cd81f2195fb866ddb0640))
* **B0-788:** force get_efficacy_data for exact dilution/efficacy/yield questions ([04365b9](https://github.com/betcocorp/bex2.0/commit/04365b9eb615d9ab45071809e73d5582c6981914))
* **B0-791:** exclude EXP- experimental aliases from fuzzy product-name matching ([474ccc0](https://github.com/betcocorp/bex2.0/commit/474ccc0c56ec20e7174d0f7ca5f014bd915e64e8))
* **B0-794:** remove 364 content-foreign SDS from the retrievable corpus ([b1039bc](https://github.com/betcocorp/bex2.0/commit/b1039bc6320f6e2f2e10f359cbab778416c53dd7))
* **B0-795:** make the xref score discriminate — AUC 0.361 -> 0.728 ([34b151f](https://github.com/betcocorp/bex2.0/commit/34b151f33607fc3d1787773d3242deac92cd8a5e))
* **B0-796:** sync efficacy is_current from frontmatter — 55 superseded reports excluded ([3263826](https://github.com/betcocorp/bex2.0/commit/32638266ba4df77e1fc9f332d4ef2b4d5143ea46))
* **B0-804:** make the English-only retrieval corpus enforced, not incidental ([df449e4](https://github.com/betcocorp/bex2.0/commit/df449e49558809ab72a8e83f2be76934f961db71))
* make OrphanRecordDialog span 50% of screen width ([6675afb](https://github.com/betcocorp/bex2.0/commit/6675afbc275af6978dce97131210988ca9981412))


### Features

* **admin:** add last run score column to test runner and update avg score display ([aa1d468](https://github.com/betcocorp/bex2.0/commit/aa1d468ed4fe539ea6663f1356c3c4962b9b254d))
* **B0-203:** idempotent orphan-SDS backfill, and correct two stale ticket premises ([ef77b90](https://github.com/betcocorp/bex2.0/commit/ef77b906524b6a9a732d298ac521f0851a2150cb))
* **B0-232:** derive the efficacy crosswalk from live data and link 125 documents ([6ad9665](https://github.com/betcocorp/bex2.0/commit/6ad9665323af611b07668245c0c9d6dd239ca7dc))
* **B0-236:** seed 27 efficacy gold eval items and record a baseline ([8fa0b4a](https://github.com/betcocorp/bex2.0/commit/8fa0b4a14f9ebd227bf4129f9373ce8d3d8b20f1))
* **B0-636:** add FastDraw dilution ingestion, tool exposure, and golden eval coverage ([8fa122e](https://github.com/betcocorp/bex2.0/commit/8fa122ed697b9d3caba904ed6214cfd1eb596463))
* **B0-765:** force GPT-5.6 Sol for run-report grading via settings row ([4c2dfb0](https://github.com/betcocorp/bex2.0/commit/4c2dfb0b0947c825b384fe1fbca6aa4c25c70788))
* **B0-786:** consolidate prompt signal detection into one pre-orchestration call ([b99b774](https://github.com/betcocorp/bex2.0/commit/b99b774a6fcb87f6304d2f037e093846b0531328))
* **B0-786:** move router model/timeout to settings and add signals rollout flag ([9de8084](https://github.com/betcocorp/bex2.0/commit/9de8084b2b7dbe856807b8e8c30b7107a54d6784))
* **B0-793:** add Score column to observability Workflow runs table ([c90ea8b](https://github.com/betcocorp/bex2.0/commit/c90ea8b47b2fab05cd815c618fde8876c2364881))
* **B0-797:** re-convert the 70 hygiene efficacy PDFs — claim tables recovered ([d8042c6](https://github.com/betcocorp/bex2.0/commit/d8042c63b239d35942d212cc12da681a5c729db8))
* **B0-804:** hide translated documents in the orphan monitor behind a toggle ([3903a5d](https://github.com/betcocorp/bex2.0/commit/3903a5d032231f977b618c473ed795933be2a01d))
* **B0-97:** xref gate calibration harness, and evidence that 0.80 is not the problem ([43be7d2](https://github.com/betcocorp/bex2.0/commit/43be7d2e9e9fc8f3ad77d6e30d235d726178ccfe))
* **B0-XXX:** add view icon button for trace reports in detailed results ([73de5fb](https://github.com/betcocorp/bex2.0/commit/73de5fb2f9afb312db0abef3afbba0f6a4335137))

# [2.18.0](https://github.com/betcocorp/bex2.0/compare/v2.17.0...v2.18.0) (2026-08-31)


### Bug Fixes

* **B0-golden-set-metrics:** scope aggregate metrics to latest run per golden set, add score change ([077d4a2](https://github.com/betcocorp/bex2.0/commit/077d4a28d7ec6a5cc850f1929ec75566130a8284))


### Features

* **B0-761:** port c360 event analytics into Bex with an /admin/analytics dashboard ([3864db3](https://github.com/betcocorp/bex2.0/commit/3864db31709b9516f876e5b659e80aa1f25430bd))

# [2.17.0](https://github.com/betcocorp/bex2.0/compare/v2.16.0...v2.17.0) (2026-08-30)


### Bug Fixes

* **B0-golden-set-metrics:** use test_results.failed_items for failing prompt count ([190a70e](https://github.com/betcocorp/bex2.0/commit/190a70e3128789dbdafc6ddf0271f177c9b0546c))


### Features

* add golden set aggregate metrics cards to /admin/tests ([652c142](https://github.com/betcocorp/bex2.0/commit/652c1427c4f4260c2394335f7954e18a2ed2a5de))
* **B0-golden-set-metrics:** display TTFT and elapsed averages in golden set metrics ([b17f9aa](https://github.com/betcocorp/bex2.0/commit/b17f9aa446b2d858ea8dcc543d2f9c2c7d6c9392))

# [2.16.0](https://github.com/betcocorp/bex2.0/compare/v2.15.2...v2.16.0) (2026-08-30)


### Bug Fixes

* **B0-759:** widen retrieval without deepening it -- depth measured, refuted ([1c2fcb5](https://github.com/betcocorp/bex2.0/commit/1c2fcb5cdd6d7bd433a362536304dde8a5c11aac)), closes [hi#touch](https://github.com/hi/issues/touch)


### Features

* add golden set badge to test report header ([17085e0](https://github.com/betcocorp/bex2.0/commit/17085e0c4b2ebd5d725c27a8feb19b1b19eb5a8b))
* default admin test router to LLM ([32918de](https://github.com/betcocorp/bex2.0/commit/32918de403ce6aadf51de119bf4c83c604bdd6b0))
* display total golden set failing items count on dashboard and health pages ([f8f5bc3](https://github.com/betcocorp/bex2.0/commit/f8f5bc357c285fa48e202f5b3cd8f8ccc5b8db8d))

## [2.15.2](https://github.com/betcocorp/bex2.0/compare/v2.15.1...v2.15.2) (2026-08-30)


### Bug Fixes

* **B0-759:** apply maxPerDocument on the unlocked retrieval path ([aebaba8](https://github.com/betcocorp/bex2.0/commit/aebaba87d041594294926d333ba7328073ad43dd))

## [2.15.1](https://github.com/betcocorp/bex2.0/compare/v2.15.0...v2.15.1) (2026-08-29)


### Bug Fixes

* **B0-759:** give procedural and enumeration questions enough evidence to answer ([69b3fb1](https://github.com/betcocorp/bex2.0/commit/69b3fb1d1d082a2e219cad0cfed5523a87aea52a))


### Reverts

* restore the Run button on /admin/tests ([8c53008](https://github.com/betcocorp/bex2.0/commit/8c5300833192ed2e882fa5f6610e24e35963fd50))

# [2.15.0](https://github.com/betcocorp/bex2.0/compare/v2.14.1...v2.15.0) (2026-08-29)


### Bug Fixes

* **B0-735:** retry synthesis calls on overflow instead of only budgeting for it ([86103c6](https://github.com/betcocorp/bex2.0/commit/86103c6205b97afdb08ae8d35809af8a663f6b62))
* **B0-751:** identify Betco products by catalog membership, not alias resolution ([6a2779c](https://github.com/betcocorp/bex2.0/commit/6a2779c0d470aa9a1d2e8043586b2a9986c1682a)), closes [#1](https://github.com/betcocorp/bex2.0/issues/1)


### Features

* **B0-750:** flag golden-set prompts on the test page and select them in one click ([f33777d](https://github.com/betcocorp/bex2.0/commit/f33777d7c7002c0c17dbe7961e9bec53afead251))
* **B0-751:** withdraw cross-reference handling when the "competitor" is Betco's own ([1b80572](https://github.com/betcocorp/bex2.0/commit/1b805721c29455588fa80549608278d63024c520))
* **B0-758:** extract brand family, setting, category and cross-turn product carry-over ([6cefe16](https://github.com/betcocorp/bex2.0/commit/6cefe16acfa08d6d2798cfb451c53e001c3b77d1))

## [2.14.1](https://github.com/betcocorp/bex2.0/compare/v2.14.0...v2.14.1) (2026-08-28)


### Bug Fixes

* **B0-734:** keep procedure, diagnosis and frequency questions with the domain specialist ([b376d80](https://github.com/betcocorp/bex2.0/commit/b376d8025647498bcd5370d63529308281bc7ee9))
* **B0-734:** require an extracted competitor before a suggested tool forces a cross-reference turn ([f03b435](https://github.com/betcocorp/bex2.0/commit/f03b43538dbec05a66c32d4be1ffe650e766f94e))
* **B0-735:** raise synthesis token caps and cap digest bullets, name truncated calls ([e7047e1](https://github.com/betcocorp/bex2.0/commit/e7047e151a2a2dcfd89b46db4181ea4e37773255))

# [2.14.0](https://github.com/betcocorp/bex2.0/compare/v2.13.0...v2.14.0) (2026-08-28)


### Bug Fixes

* **B0-733:** show actual routing method even when settings-driven ([3e650b7](https://github.com/betcocorp/bex2.0/commit/3e650b772f12c7b659f917e0bd5646a55e76ca20))
* **B0-734:** expose the category tools on the recommendations route its policy names ([4a05fee](https://github.com/betcocorp/bex2.0/commit/4a05fee7348df65c1af7d95cc9300f9ce304ca52))
* **B0-735:** chunk eval report synthesis so it stops silently failing on large runs ([06826a1](https://github.com/betcocorp/bex2.0/commit/06826a16b469abed33c93c6fe3a1144f3104d5f2))


### Features

* **B0-733:** surface model, router type, and appVersion in reports table ([6149f00](https://github.com/betcocorp/bex2.0/commit/6149f00cd20900f9afed2c04a9e0bcae53310a9c))
* **B0-734:** move the early-decline gate to the settings table, default off ([cd7e206](https://github.com/betcocorp/bex2.0/commit/cd7e20628c40d97c0dddab480051fd604fd38daf))
* **B0-734:** rewrite specialist prompts to the eval report's grading basis ([0ec4463](https://github.com/betcocorp/bex2.0/commit/0ec44632bcba7d48309c6623dc018c2685253b27))

# [2.13.0](https://github.com/betcocorp/bex2.0/compare/v2.12.0...v2.13.0) (2026-08-28)


### Bug Fixes

* **B0-693:** require margin corroboration for a high-confidence product-line lock on regulated queries ([faa5a07](https://github.com/betcocorp/bex2.0/commit/faa5a07aef0f2076bcf8f6857d67b3477f2190f5)), closes [hi#confidence](https://github.com/hi/issues/confidence)


### Features

* **B0-732:** surface alias resolution hits in the run trace timeline ([f8ac872](https://github.com/betcocorp/bex2.0/commit/f8ac8729b1ad012bcef0855f59629f32b65f4e98))

# [2.12.0](https://github.com/betcocorp/bex2.0/compare/v2.11.1...v2.12.0) (2026-08-27)


### Bug Fixes

* **B0-726:** sharpen best/strongest routing boundary and add ranking-claim gate ([9d147af](https://github.com/betcocorp/bex2.0/commit/9d147aff54c1f96b65a5a27dbcedab500599209e))
* **B0-727:** add SDS/shelf-life lifecycle escalation script ([9ded70e](https://github.com/betcocorp/bex2.0/commit/9ded70ee17cb10cfa9eac48f47fbd4f1d3527e0f))
* **B0-729:** add organism/efficacy claim non-transfer caveat to cross-reference specialist ([dff650d](https://github.com/betcocorp/bex2.0/commit/dff650d17ff0f45dcf19dea96435f05d9a98855c))
* **B0-730:** require per-product label/EPA citation for technical claims ([199624b](https://github.com/betcocorp/bex2.0/commit/199624b011844ed8cf99f74c18d5e7cf3bcc7593))


### Features

* **B0-706:** add a collapse/expand-all control to the report case ledger ([2686613](https://github.com/betcocorp/bex2.0/commit/26866136d017b6d2de3a5fc01202910f835ee6f8))
* **B0-707:** add a per-case trace download to the report case ledger ([cf99c45](https://github.com/betcocorp/bex2.0/commit/cf99c4556935c2457259845ee2dd996577367a4a))
* **B0-708:** gate report Results on concept coverage, with hard structural invariants ([5da2425](https://github.com/betcocorp/bex2.0/commit/5da2425897beeaddad2c68993bc2a38ae8c363f1))
* **B0-709:** replace the report's latency block with a two-metric Speed Performance Score ([94f5cfc](https://github.com/betcocorp/bex2.0/commit/94f5cfcbc917d8bf102d73e88dba9b0f935520c3))
* **B0-710:** grade over N independent passes and report where they disagree ([70737d4](https://github.com/betcocorp/bex2.0/commit/70737d4448c41ddee29a9339629d9853b742185e))
* **B0-716:** add a speed-rules module for the report's speed thresholds ([0aac24f](https://github.com/betcocorp/bex2.0/commit/0aac24f3ef3eaea033f0d3dcf1ce73c983cea430))
* **B0-722:** add endpoint testing to Web Endpoints page ([09a7af3](https://github.com/betcocorp/bex2.0/commit/09a7af3a42034e0e61b79c7061631c152b0e6b4d))
* **B0-723:** add Bearer token input to Web Endpoints example request form ([c7a2530](https://github.com/betcocorp/bex2.0/commit/c7a253065c20821ee96546ac1e33c258057c699a))
* **B0-724:** add click-to-copy for token prefixes in app management ([0646fa8](https://github.com/betcocorp/bex2.0/commit/0646fa89bce5395a536959789d73149bcfc2d4cf))
* **B0-724:** add clipboard icon with checkmark feedback to token prefix copy ([559b155](https://github.com/betcocorp/bex2.0/commit/559b155ea3104fabff1e71577fc1f14bd713c769))
* **B0-728:** require clarify-before-recommend across product/recommendations/cross_reference ([9a69624](https://github.com/betcocorp/bex2.0/commit/9a6962405788d6f0a99b813c6db039ae1049831f))
* **B0:** add Web Endpoints documentation page to admin tools ([a5c2657](https://github.com/betcocorp/bex2.0/commit/a5c26570f1030014e24aeaf8e17297a37cb9049f))

## [2.11.1](https://github.com/betcocorp/bex2.0/compare/v2.11.0...v2.11.1) (2026-08-27)


### Bug Fixes

* **B0-264:** correct the dilution eval's abstention rows and teach the CSV importer expected_criteria ([a5b1bbc](https://github.com/betcocorp/bex2.0/commit/a5b1bbc153aa470ee00c7d1f9a007e43a2cd685b)), closes [#1](https://github.com/betcocorp/bex2.0/issues/1) [#2](https://github.com/betcocorp/bex2.0/issues/2)

# [2.11.0](https://github.com/betcocorp/bex2.0/compare/v2.10.0...v2.11.0) (2026-08-27)


### Bug Fixes

* **B0-16:** dedupe RAG SDS results on product identity instead of chunk text ([9e2257d](https://github.com/betcocorp/bex2.0/commit/9e2257d0af3debc35c3639f5d938f381aaadfa09))
* **B0-355:** enforce and instrument the cross-reference recommendation engine ([3ce8909](https://github.com/betcocorp/bex2.0/commit/3ce89099c2b66938fb57ec7c69710ded039549ad))
* **B0-373:** give /admin/bex/compare its own loading.tsx instead of the chat skeleton ([a3a3fea](https://github.com/betcocorp/bex2.0/commit/a3a3feac94d34c5a58e96a1cac81cf4601a2fd86))
* **B0-464:** audit live schema drift and gate it in CI ([f8b30b1](https://github.com/betcocorp/bex2.0/commit/f8b30b163ba9a8421b5e7d53421c2dcf24afc9bb))
* **B0-694:** promote test_items.expected_tool from metadata jsonb to a typed column ([3dff47f](https://github.com/betcocorp/bex2.0/commit/3dff47f4f4c07e548d3463e50c2069682092666a))
* **B0-696:** gate unverified aliases out of the exact-match and tokenized-fuzzy resolution tiers ([ab40c03](https://github.com/betcocorp/bex2.0/commit/ab40c033387e8c4d51569816fc979f160d2e9a55))


### Features

* **B0-264:** extract dilution from ingested label documents, with skip audit ([763d755](https://github.com/betcocorp/bex2.0/commit/763d7555a3ed91cc44b8b4013c5c93149ecbb467))
* **B0-351:** per-run agent-mode config for the test runner, and one parser for run_options ([d34f29f](https://github.com/betcocorp/bex2.0/commit/d34f29fe6b49d8220d812ba53983e53e32274221))
* **B0-372:** add shape-matched loading.tsx to routes falling back to the generic /admin skeleton ([b3faed1](https://github.com/betcocorp/bex2.0/commit/b3faed1683ce25c3e332204076b12f9d15998c4b))
* **B0-378:** replay prior-turn tool context on the AI SDK generation path ([23edd74](https://github.com/betcocorp/bex2.0/commit/23edd74d96452354e58c8de2b72c814113586d6e))
* **B0-466:** alert on tool-failure-rate and golden-set pass-rate regressions ([d2d9b0c](https://github.com/betcocorp/bex2.0/commit/d2d9b0c883d0051303bc658d34d6d54ec2ab0a35))
* **B0-496:** add the confidence and similarity integrity panel plus a coverage assertion test ([36f90be](https://github.com/betcocorp/bex2.0/commit/36f90beb80fc984f9ae2463b38e9cb62ec61b909))
* **B0-529:** add get_dispenser_asset and get_floor_asset knowledge tools ([9e46685](https://github.com/betcocorp/bex2.0/commit/9e46685e210d2a739ad9855d24af38bcf525f586))
* **B0-537,B0-538:** multi-turn eval format and cross-turn assertion evaluator ([2217e67](https://github.com/betcocorp/bex2.0/commit/2217e67638490f7feb4b5999c78db16b2e6a6a42))
* **B0-586:** add the structured report data contract and endpoint ([cf848a3](https://github.com/betcocorp/bex2.0/commit/cf848a34e0d369c558d61d20c5fe7c54a2cf6d1b))
* **B0-587:** add the report verdict strip ([1c5aa6f](https://github.com/betcocorp/bex2.0/commit/1c5aa6f6921ffec1f09fbed3c4855e3930d39346))
* **B0-588:** add the report tier, category and responsiveness cards ([c04e04b](https://github.com/betcocorp/bex2.0/commit/c04e04b218b880c30420130745ba975aa11bfe57))
* **B0-589:** add the top-3 fix cards with derived evidence chips ([8c9023a](https://github.com/betcocorp/bex2.0/commit/8c9023a38475415898c3ba32c8eca66bd6f3d6b3))
* **B0-590:** add the case ledger with tier grouping, filters and in-place expansion ([5b19e41](https://github.com/betcocorp/bex2.0/commit/5b19e4188a910c65e1e4f3e5b46473b7596a9019))
* **B0-591:** add the executive assessment, aggregate findings and methodology sections ([4c2b8c0](https://github.com/betcocorp/bex2.0/commit/4c2b8c0276ff747d20caee762e7a5f13ee39ba87))
* **B0-592:** render the verdict-first report layout and re-point the PDF export at it ([8907248](https://github.com/betcocorp/bex2.0/commit/8907248c22d7e817062240d1af0ec17420e0b7d1))
* **B0-680:** add the pre-computed semantic router embeddings generator and artifact ([3aff5a4](https://github.com/betcocorp/bex2.0/commit/3aff5a42ed99b164ac831c7d59486366de20b8ca))
* **B0-695:** switch LLM router's classifier model to gpt-4.1-mini ([78f9caf](https://github.com/betcocorp/bex2.0/commit/78f9cafb51da0dd856b2e80ad1f3f99c434f38cc))
* **B0-698:** add router comparison charts to /admin/routing-test ([0d5447a](https://github.com/betcocorp/bex2.0/commit/0d5447a0a316e8fadfd5f42a747213cb571f670b))


### Reverts

* **B0-695:** switch LLM router's classifier model back to gpt-4o-mini ([e3b9c68](https://github.com/betcocorp/bex2.0/commit/e3b9c68dd5a94c859d604192f10e7cccca63ff43))

# [2.10.0](https://github.com/betcocorp/bex2.0/compare/v2.9.0...v2.10.0) (2026-08-27)


### Bug Fixes

* **B0-479:** resolve aliases for freeformQuery product doc searches ([48d2354](https://github.com/betcocorp/bex2.0/commit/48d23544e734fca07bd2ecc0c8c1934067ad9262)), closes [hi#precision](https://github.com/hi/issues/precision)
* **B0-480:** give the alias regression gold set real grading criteria ([c80bfb9](https://github.com/betcocorp/bex2.0/commit/c80bfb92c692873bd0084c5b11ca03cb494b15f0))
* **B0-484:** fix parenthetical acronym recall and guard script entrypoint ([c8c2b5c](https://github.com/betcocorp/bex2.0/commit/c8c2b5c8001570221574fdef2e36919a5ff1e934))
* **B0-673:** update stale SME_AGENT_IDS assertion to include cross_reference ([709c806](https://github.com/betcocorp/bex2.0/commit/709c80615ab4317dc0da817f13718cc9a9a6114f))
* **B0-683:** apply missing failure-queue root-cause migration, split cause/fix display ([0b47e60](https://github.com/betcocorp/bex2.0/commit/0b47e6086fd4d83251a78108f6372d53155101a2))
* **B0-684:** Fix document-lookup schema bug and legacy reference targeting ([63ebc73](https://github.com/betcocorp/bex2.0/commit/63ebc734d452d733cf5f77ae5b5549e9bbe4a383))
* **B0-684:** Link document_key references to legacy source, not back to same page ([e190f3f](https://github.com/betcocorp/bex2.0/commit/e190f3fc44a5b28ac46b263cd8140a20963dd6cf))


### Features

* **B0-311:** trigger post-mortem comparison job on run completion ([94b6882](https://github.com/betcocorp/bex2.0/commit/94b6882c0568e4ae35eabb70c17337d3c03091a1))
* **B0-312:** add test_result_comparisons table and repository methods ([46b8264](https://github.com/betcocorp/bex2.0/commit/46b8264ca32a9de7b6a36d35e57d99a2483d2ea5))
* **B0-313:** compute run-vs-previous-run diff for post-mortem comparison ([39b240b](https://github.com/betcocorp/bex2.0/commit/39b240bee3fad8a605613cc7e4b7c43f9f182cab))
* **B0-314:** add LLM cause/fix analysis for run comparisons ([3606f71](https://github.com/betcocorp/bex2.0/commit/3606f7111ed24f6cb30b5c576be9d01223ace0fb))
* **B0-315:** render post-mortem comparison on run detail page ([866091e](https://github.com/betcocorp/bex2.0/commit/866091e59e2f8b011403f64f48df2c58274e7ad7))
* **B0-486:** enforce formulation-variant rules on alias approval ([4e9b84d](https://github.com/betcocorp/bex2.0/commit/4e9b84df1932ab2729d91ede9ece156bf92fab77))
* **B0-660:** don't ask for a surface the user already named ([ec3c2f8](https://github.com/betcocorp/bex2.0/commit/ec3c2f87e6a1624686a238cabcf61399d84c9f9c))
* **B0-682:** Add interactive example calls and response testing to admin tool documentation ([561c393](https://github.com/betcocorp/bex2.0/commit/561c393242236884903925fdfacdc226a76139a3))
* **B0-684:** Add API endpoint to resolve product_line_key and sku to document IDs ([f943d73](https://github.com/betcocorp/bex2.0/commit/f943d73658a34e9eb50372dfd7d61c47c9653c6a))
* **B0-684:** Add linkify legacy:*:<id> references in document viewer chunk text ([5d31d06](https://github.com/betcocorp/bex2.0/commit/5d31d06be59642276d14c18e41be43df56d13f8e))
* **B0-684:** Make ingestion panel S3 keys open the file via signed URLs ([9f53202](https://github.com/betcocorp/bex2.0/commit/9f53202e11e52e678f802c11b656100e9bc434ce))
* **B0-684:** Make Product line and SKU fields clickable in RagSearchResultCard ([a7aaf55](https://github.com/betcocorp/bex2.0/commit/a7aaf55ffd99e9378c873a33b0870f78bffe11be))
* **B0-684:** Open ingested source files via short-lived signed S3 URLs ([afe0b94](https://github.com/betcocorp/bex2.0/commit/afe0b941d20b0e70e6c7c8c8aa5a41a337e41d3b))
* **B0-687:** add cross-dataset eval report index at /admin/tests/reports ([7abe07e](https://github.com/betcocorp/bex2.0/commit/7abe07ea6b849d0f924681726a1ec5aa32579f62))
* **B0-687:** record who started a test run on test_results.triggered_by ([6c46453](https://github.com/betcocorp/bex2.0/commit/6c46453ee2d739ec91e823b9747ccf7ebda4eb4d))
* **B0-688:** exclude archived test sets from the report index ([a46634f](https://github.com/betcocorp/bex2.0/commit/a46634f17878cc5e285db77d462e2abeeca3f8e3))
* **B0-689:** chart eval scores over time with run-over-run change ([3e7e84e](https://github.com/betcocorp/bex2.0/commit/3e7e84ef7eaafe6af036e44d28477ffaf10cb470))
* **B0-690:** add a dataset filter to the eval report index ([aa9d1d3](https://github.com/betcocorp/bex2.0/commit/aa9d1d3923aee9f80cd794ff1c55afe06ca7f0c6))
* **B0-ROG:** Add view source document links and delete French corpus ([32e2510](https://github.com/betcocorp/bex2.0/commit/32e2510ab35a5532353bba9ef271ddbaf1cd9782))


### Performance Improvements

* **B0-686:** replace paged chunk-stats sweep with chunk_token_stats RPC ([bf7d061](https://github.com/betcocorp/bex2.0/commit/bf7d061a6ddedf3e33a3af10d523ffeb343ac5d2))

# [2.9.0](https://github.com/betcocorp/bex2.0/compare/v2.8.0...v2.9.0) (2026-08-25)


### Features

* **B0-681:** add per-run router selector to test dataset run form ([75b0261](https://github.com/betcocorp/bex2.0/commit/75b02615a0eb11778e31cee4933075373720783c))

# [2.8.0](https://github.com/betcocorp/bex2.0/compare/v2.7.0...v2.8.0) (2026-08-25)


### Bug Fixes

* **B0-664:** add missing test-run owner variant to conversation schema ([a17feff](https://github.com/betcocorp/bex2.0/commit/a17fefff9c7261d88faf694d138a9f2c287908ab))
* **B0-665:** allow cross_reference in routing_test_items check constraint ([f47ff60](https://github.com/betcocorp/bex2.0/commit/f47ff600d7c1ab2232010b872cd2f62d42da600a))


### Features

* **B0-663:** split cross-reference and recommendations into two SME agents ([4f4f6ef](https://github.com/betcocorp/bex2.0/commit/4f4f6efe22068b2bf9b682db0c82cee2a67fac42))
* **B0-666:** add LLM router as a third option in the routing test tool ([2f4ca0c](https://github.com/betcocorp/bex2.0/commit/2f4ca0cd7ffa4847097e672c7eb13e8b76d3ca89))
* **B0-667:** persist routing test run history with per-run summary and per-item drill-down ([809f6d5](https://github.com/betcocorp/bex2.0/commit/809f6d5c53f9e21124cc74bd785c0889a4c6f38a))
* **B0-668:** lead routing-comparison dashboard with LLM vs semantic, demote keyword ([e4f0ea3](https://github.com/betcocorp/bex2.0/commit/e4f0ea3188b95c4040f4d3400edb4905f1b585c7))
* **B0-669:** add embedding_large/embedding_model_large to routing_test_items ([848b12b](https://github.com/betcocorp/bex2.0/commit/848b12babd9115a71abb1337d8e251ca4d1f3848))
* **B0-670:** color-code routing test accuracy (green >80%, red <=50%) ([b32719d](https://github.com/betcocorp/bex2.0/commit/b32719dd6d2d6b1c7c4f7fdb48296db9eef5ccbd))
* **B0-671:** add LLM model selector next to router selection on routing test ([e0b095c](https://github.com/betcocorp/bex2.0/commit/e0b095c39247ecfec0a5ede331167c385a705077))
* **B0-675:** group routing test items by specialist, add create-another to add dialog ([c0738fb](https://github.com/betcocorp/bex2.0/commit/c0738fb9b784ce80f2d3a9f88543994283f4c0b2))

# [2.7.0](https://github.com/betcocorp/bex2.0/compare/v2.6.0...v2.7.0) (2026-08-25)


### Bug Fixes

* **B0-662:** catch dataset create/upload failures and toast instead of crashing ([1d6a78e](https://github.com/betcocorp/bex2.0/commit/1d6a78ea17a5d8e7d1377c5b868663dda18a0233))


### Features

* **B0-647:** define semantic router example corpus and lazy startup pre-compute ([a960366](https://github.com/betcocorp/bex2.0/commit/a960366aa1edb8c869390d4e5d405b5b37426c1a))
* **B0-648:** implement semantic similarity matching service ([cce473e](https://github.com/betcocorp/bex2.0/commit/cce473ede1239587ac0dded5944b3c7d71f03798))
* **B0-649:** integrate semantic router into the orchestrator with shadow mode ([cda86a0](https://github.com/betcocorp/bex2.0/commit/cda86a0e09ba57c491db32200be17f92d1a105ee))
* **B0-650:** add confidence and margin thresholds for semantic routing safety ([60468d6](https://github.com/betcocorp/bex2.0/commit/60468d614c1205c6ea4727a7abc02a3eaca94533))
* **B0-651:** add semantic router observability and derived metrics ([8da49ad](https://github.com/betcocorp/bex2.0/commit/8da49ad4de4bb2b46b9f5a677218aa1995fe239b))
* **B0-652:** extend eval harness for semantic router routing accuracy ([79e5758](https://github.com/betcocorp/bex2.0/commit/79e57589eba4ec104703093d80db84f336f2e624))
* **B0-654:** cache semantic router example embeddings in Redis ([cd5862e](https://github.com/betcocorp/bex2.0/commit/cd5862ee20756de782d52823324c167542dc15c5))
* **B0-656:** add ROUTER_TYPE setting to select the active router implementation ([22a45a6](https://github.com/betcocorp/bex2.0/commit/22a45a68e1f03ba586ac379b8021d81fb6c89b01))
* **B0-657:** add routing test data model and CRUD actions ([1ffae9b](https://github.com/betcocorp/bex2.0/commit/1ffae9b7fec6c63afe214066598bc15ffbf53b52))
* **B0-658:** add routing test admin page and nav entry ([a0a3c4e](https://github.com/betcocorp/bex2.0/commit/a0a3c4e5d65ebfa6ab4749929a48097edf69a00d))
* **B0-659:** run routing test items against a selectable router ([51157a7](https://github.com/betcocorp/bex2.0/commit/51157a732ec2064efca191c1466655de535fad00))

# [2.6.0](https://github.com/betcocorp/bex2.0/compare/v2.5.0...v2.6.0) (2026-08-24)


### Bug Fixes

* **B0-634:** resolve product-line facts across entity tiers ([a273570](https://github.com/betcocorp/bex2.0/commit/a2735701487e8c58d43999ff7b0284198b00a944))
* **B0-639:** clear Bex chat composer and restore focus after send ([4e402f4](https://github.com/betcocorp/bex2.0/commit/4e402f43cb03e7902cac4f27c8fb4f7aa0c2b2ef))
* **B0-640:** stop diluting Tavily relevance and starving enrich of raw content ([a113e16](https://github.com/betcocorp/bex2.0/commit/a113e16ad3d071d4656a7ddd730edde069709d2f)), closes [hi#signal](https://github.com/hi/issues/signal)
* **B0-643:** restore bex.chat.view-all permission grant for it-admin ([2a68c07](https://github.com/betcocorp/bex2.0/commit/2a68c0765c7e9ab57d133ba66e07b4bb599133d5))
* remove unused NextAuth accessToken pass-through ([120846f](https://github.com/betcocorp/bex2.0/commit/120846ffadc36f2f7b6cd4448f0ea61fc2968efb))


### Features

* **B0-635:** stop retrieval once searches stop finding anything new ([60d467d](https://github.com/betcocorp/bex2.0/commit/60d467d370af9a0c369509451c79dc06f2dea6dd))
* **B0-644:** add archive/restore capability for test datasets ([9645500](https://github.com/betcocorp/bex2.0/commit/9645500f2186a626df0eea7c1a727ea16c7531fb))
* **B0-645:** store test name on agent conversations for admin sidebar ([cd29e5b](https://github.com/betcocorp/bex2.0/commit/cd29e5b0233576fa3675f73a45f02bfa669e4ea7))

# [2.5.0](https://github.com/betcocorp/bex2.0/compare/v2.4.0...v2.5.0) (2026-08-23)


### Bug Fixes

* **B0-484:** gate corpus alias mining on name derivation ([e1797fb](https://github.com/betcocorp/bex2.0/commit/e1797fbb199ee6fd12ed21e08123ee18371f93a0))
* **B0-631:** aggressive table width reduction ([7fea643](https://github.com/betcocorp/bex2.0/commit/7fea6435189d4cbc6f0745477545fe8d7fb6468d))
* **B0-631:** improve dialog scroll behavior ([96a5661](https://github.com/betcocorp/bex2.0/commit/96a566117b6db0105bf7ccb5b5281b408f5e18d0))
* **B0-631:** reduce horizontal scrolling in column reference table ([e982c11](https://github.com/betcocorp/bex2.0/commit/e982c11307125939f81bf821d0c50fc887844c3d))
* **B0-631:** set fixed width for column reference description ([77bf9b4](https://github.com/betcocorp/bex2.0/commit/77bf9b41dcaebbafe81c34e182b957b65b7beea0))


### Features

* **B0-249:** link resolvable label docs to product-line entities ([1021a8c](https://github.com/betcocorp/bex2.0/commit/1021a8c1224aa39830872506cb312330157d4359))

# [2.4.0](https://github.com/betcocorp/bex2.0/compare/v2.3.0...v2.4.0) (2026-08-22)


### Features

* **B0-629:** replace /admin with Mission Control dashboard ([1e2efb0](https://github.com/betcocorp/bex2.0/commit/1e2efb0e9f9b09c4b6bbfd760e8e9eda92efe960))

# [2.3.0](https://github.com/betcocorp/bex2.0/compare/v2.2.0...v2.3.0) (2026-08-22)


### Bug Fixes

* **B0-621:** use clickable inspect buttons for result-card doc/chunk footer ([a996e5d](https://github.com/betcocorp/bex2.0/commit/a996e5d3ccf2370683ff870ffca723c89ca78c1e))
* **B0-622:** render RAG document body_markdown through Streamdown ([ef3b659](https://github.com/betcocorp/bex2.0/commit/ef3b65904e1fb282b6f10fe110082f354862db4f))


### Features

* **B0-621:** redesign RAG semantic search page with settings drawer and card grid ([3d59978](https://github.com/betcocorp/bex2.0/commit/3d5997850e7cc4f026a8b681324b5d69f83324c5))

# [2.2.0](https://github.com/betcocorp/bex2.0/compare/v2.1.0...v2.2.0) (2026-08-21)


### Features

* **B0-619:** surface retrieval strategy, rerank timing, and product-line lock ([86187a3](https://github.com/betcocorp/bex2.0/commit/86187a30f2c33f296218f3a54ef28bbeb51b2c17))

# [2.1.0](https://github.com/betcocorp/bex2.0/compare/v2.0.0...v2.1.0) (2026-08-21)


### Bug Fixes

* **B0-354:** unify the two divergent cross-reference intent detectors ([79f91cf](https://github.com/betcocorp/bex2.0/commit/79f91cf27802e9fee662453b598c439946899847))
* **B0-465:** trigger a fresh golden-set run per PR instead of grading a pinned run id ([a18ce81](https://github.com/betcocorp/bex2.0/commit/a18ce81bad02c42c4a1657a936a90a9f7e2de46d))
* **B0-556:** never ground a safety answer on another product line's SDS ([92cfff5](https://github.com/betcocorp/bex2.0/commit/92cfff5d349f9cbdd91ea99706862805570ed97a))
* **B0-606:** stop sending temperature to models that reject it ([dc5aff7](https://github.com/betcocorp/bex2.0/commit/dc5aff73aa5568ffb2c81bb9b471e3a298e046b8))
* **B0-607:** apply settings migrations via Supabase MCP, use service-role client ([683ea5e](https://github.com/betcocorp/bex2.0/commit/683ea5edcc7ffe88c30416c78c763138363491f7))
* **B0-607:** remove appVersion display from admin account menu ([e49e91e](https://github.com/betcocorp/bex2.0/commit/e49e91ea30986b58cc5f8a647bbeceb9fecee90c))
* **B0-612:** correct off-by-one in case split that shifted tone alternation ([ed7d339](https://github.com/betcocorp/bex2.0/commit/ed7d339b657326f6046389122f0340fa7970ae4f))
* **B0-XXX:** always send metadata in streaming response and use text format for synthesis payload ([d60c497](https://github.com/betcocorp/bex2.0/commit/d60c497a1a258052e01b5e612ce329845a89b709))
* **B0-XXX:** don't re-throw error after writing stream metadata ([7ae155a](https://github.com/betcocorp/bex2.0/commit/7ae155a352041df9f6957d964bcd27ef7e08c009))
* **B0-xxx:** honor the ?conversationId deep link on the Bex chat page ([5b7ebf2](https://github.com/betcocorp/bex2.0/commit/5b7ebf2fa05d9055245153d4a29d3f55837e3484))


### Features

* **B0-292:** surface web search results found by recommend_cross_reference ([b590669](https://github.com/betcocorp/bex2.0/commit/b590669d4f635f4fde6827c268f5559410d4e1a5))
* **B0-338:** attribute every workflow run to who asked ([0976b94](https://github.com/betcocorp/bex2.0/commit/0976b94695ee581b94842db8bedf659a499971fa))
* **B0-350:** keep the streamed draft on a validator rejection instead of snapping to a decline ([ec3f5f5](https://github.com/betcocorp/bex2.0/commit/ec3f5f5580596326fb4be9860b5095114099ef0e))
* **B0-353:** split recommendation pending into pending + escalated ([45bca4f](https://github.com/betcocorp/bex2.0/commit/45bca4fc391b1f3b5e6439a67e0aac4a938ecb8c))
* **B0-564:** add gpt-5.5/gpt-5.6 model tags and wire them end to end ([01e20ee](https://github.com/betcocorp/bex2.0/commit/01e20ee582902668944799631bb12d5ddfc48161))
* **B0-572:** define the gating golden set with audited membership and tier validation ([697d97a](https://github.com/betcocorp/bex2.0/commit/697d97aafb776cb06c5762ec3e75084312d05019))
* **B0-573:** persist per-tier pass-rate targets and gate semantics ([1d9395f](https://github.com/betcocorp/bex2.0/commit/1d9395fddc5e2f0fbf890bbaca1c17a4735160f6))
* **B0-574:** stamp app_version and prompt_bundle_version on workflow_runs ([c5cbea9](https://github.com/betcocorp/bex2.0/commit/c5cbea9b719ea7cec17a6bdadfac42ddbf920035))
* **B0-575:** close app_version gaps and add version-to-run resolution for golden rollups ([5b70954](https://github.com/betcocorp/bex2.0/commit/5b70954e892bef65a3e40afddf9290484e361046))
* **B0-576:** per-tier daily pass-rate trend series with window deltas ([801e702](https://github.com/betcocorp/bex2.0/commit/801e702bb933ff104157a862909921edf886da3b))
* **B0-577:** Bex Health route, page shell and sidebar entry ([c3ce9b9](https://github.com/betcocorp/bex2.0/commit/c3ce9b9e2fff4f0839b99dfd533bfb10a1fa4d31))
* **B0-578:** window and version selectors, searchParams-driven ([772c61c](https://github.com/betcocorp/bex2.0/commit/772c61c74320266a82e5c5850f71b476cbf0cc6a))
* **B0-579:** blocked/clear verdict strip with explicit unknown state ([a898e82](https://github.com/betcocorp/bex2.0/commit/a898e82369a979d33472306318c5346d39348dba))
* **B0-580:** golden-set tier cards and final panel integration ([9502425](https://github.com/betcocorp/bex2.0/commit/950242559c4411858033f07c258cbf99682e675e))
* **B0-581:** live traffic card with token usage and version-filterable window scan ([d72c0f5](https://github.com/betcocorp/bex2.0/commit/d72c0f53d1c1cf14f83da2bdb6f7e5e1a5e5b305))
* **B0-582:** pipeline stage strip with stage-to-step mapping and clamped durations ([45d0887](https://github.com/betcocorp/bex2.0/commit/45d0887f102c143d5c9cc36243d32e84272f6c48))
* **B0-583:** tokens-per-day panel from cost_by_model_per_day ([06cebd5](https://github.com/betcocorp/bex2.0/commit/06cebd5c28656b02b02ee8213508fcb813996b40))
* **B0-584:** per-panel provenance footers on the Bex Health dashboard ([3b42c72](https://github.com/betcocorp/bex2.0/commit/3b42c7210be8ebcb91783e35fe7e82c5a8a0f223))
* **B0-585:** decommission the superseded aggregate dashboards ([6da4571](https://github.com/betcocorp/bex2.0/commit/6da457150016bdd102c7733b986c0c0c7d607515))
* **B0-593:** add a tool call filter to the observability runs list ([72cd95a](https://github.com/betcocorp/bex2.0/commit/72cd95a6bae573ba7ffe5f045bedc18525f6f1fe))
* **B0-598:** resolve gpt-5.5/gpt-5.6 with BEX_MODEL_GPT55/56 overrides ([83148e8](https://github.com/betcocorp/bex2.0/commit/83148e8332d2e2ab8dc5c85ed376beb1a3dbd714))
* **B0-599:** add BexModelTag, BEX_MODEL_TAGS and MODEL_DESCRIPTIONS ([0e804ff](https://github.com/betcocorp/bex2.0/commit/0e804ff806703d5d89a45f8fdea36e4cd0660438))
* **B0-600:** add createModelComparisonRun and make the validator opt-in per run ([584254e](https://github.com/betcocorp/bex2.0/commit/584254e200d393b20e1e19f8c95943b0e6212f1b))
* **B0-601:** show model descriptions and a validator toggle on the run form ([20cbf0c](https://github.com/betcocorp/bex2.0/commit/20cbf0cde38136b0a46c9c16a368896d3cee990d))
* **B0-602:** show the selected model's description in the Bex chat picker ([84a8d4a](https://github.com/betcocorp/bex2.0/commit/84a8d4acd97d99b176124c16604e110c8d97b114))
* **B0-607:** add settings page with environment variable toggles ([a7a7736](https://github.com/betcocorp/bex2.0/commit/a7a77362729497293db90c41a7ea268e6c00d484))
* **B0-607:** show app version above Dashboard header in admin layout ([66e4e41](https://github.com/betcocorp/bex2.0/commit/66e4e41d171a4b80106e6f15899ad841f8f52096))
* **B0-608:** auto-generate eval report when a test run completes ([4135922](https://github.com/betcocorp/bex2.0/commit/4135922ea055b73c59ba12fe12b7ed729d93baab))
* **B0-609:** show overall report score in the Recent runs table ([f4f8d8a](https://github.com/betcocorp/bex2.0/commit/f4f8d8aaff442c9b216cf2782470a7d3fb1fb1cd))
* **B0-610:** add a run-over-run trend indicator to the Score column ([3e03489](https://github.com/betcocorp/bex2.0/commit/3e0348975c9e66ecb8d02357f3a91c55c86dce8a))
* **B0-611:** make the "Generating report…" button link to the report page ([3650a19](https://github.com/betcocorp/bex2.0/commit/3650a1926df82473a9f188089d61d16c2a0ad76c))
* **B0-612:** two-tone alternating cases in the report's case-by-case detail ([c6a0b1f](https://github.com/betcocorp/bex2.0/commit/c6a0b1f5b962d9708185ccd409a89fb1459690cf))
* **B0-613:** eval report formatting pass — quote heading, dedupe boilerplate, fix lists, drop pseudocode, reorder assessment ([9e27266](https://github.com/betcocorp/bex2.0/commit/9e27266a8069187882a65980a1f1ac8331577a88))
* **B0-614:** default model selector to gpt-4.1 in test dataset details ([c7cb502](https://github.com/betcocorp/bex2.0/commit/c7cb502fb2eca120f1be0b77e831427b56383edf))
* **B0-614:** structured per-criterion grading for the eval harness ([c5c426e](https://github.com/betcocorp/bex2.0/commit/c5c426e0f6c19952670200c76a0d75955cf25f7a))
* **B0-618:** read ENABLE_RERANKER and COHERE_RERANK_MODEL from settings table ([c76ce08](https://github.com/betcocorp/bex2.0/commit/c76ce0826974c06911f4f50a31530dc3c20f1b3a))
* **B0-xxx:** add bex chat links to observability run traces ([272539e](https://github.com/betcocorp/bex2.0/commit/272539e9731fa1591573dde35d4ea3dc7b8022c9))
* **B0-xxx:** add conversationId query param support to Bex chat ([cfe1b33](https://github.com/betcocorp/bex2.0/commit/cfe1b3345a28ef432762c8bae09876bfaba16487))
* **B0:** add trace link in Details section of Bex chat responses ([1015e63](https://github.com/betcocorp/bex2.0/commit/1015e638b7d2142c084c97380e8bdf3ef1a3f28e))

# [2.0.0](https://github.com/betcocorp/bex2.0/compare/v1.2.1...v2.0.0) (2026-08-20)


* feat(B0-511)!: make LLM intent routing the default and retire keyword routing from every decision path ([43a90e9](https://github.com/betcocorp/bex2.0/commit/43a90e97d83b7c0c73232b27a450ebcb7c776f48))


### Bug Fixes

* **B0-560:** drop the dead actions prop usage on PermissionGroupPage ([8fb32cf](https://github.com/betcocorp/bex2.0/commit/8fb32cf923a1ff8ae46fbb185b8f24f55c94568c))
* **B0-560:** reconcile nav-permission migration with actual live DB state ([115adb6](https://github.com/betcocorp/bex2.0/commit/115adb6b9d9467b8061b86bf995c156a7d1b9e5c))
* **B0-567:** default cost monitoring to the 1d time range ([82bbfef](https://github.com/betcocorp/bex2.0/commit/82bbfef067f93c18921e68729e262cb869bc5f67))


### Features

* **B0-563:** capture token usage on every model-calling workflow step ([b1d594f](https://github.com/betcocorp/bex2.0/commit/b1d594f1c0279556e01f546afcb20f02b94a2275))
* **B0-564:** add model_pricing table with dated $/Mtok rates ([fcb6d1e](https://github.com/betcocorp/bex2.0/commit/fcb6d1e6bf4e12e3b9fa9a41e532b2ddd0bce71a))
* **B0-566:** add GET /api/bex/cost/metrics ([c491993](https://github.com/betcocorp/bex2.0/commit/c491993c17a69bd93ce64519aae4cb4afb7cc2a6))
* **B0-567:** add /admin/cost dashboard with protected nav item ([5151223](https://github.com/betcocorp/bex2.0/commit/5151223c48f4d8750d36e4673483d6b2b47f17b5))
* **B0-567:** add a "Runs covered" summary card to cost monitoring ([07b5a93](https://github.com/betcocorp/bex2.0/commit/07b5a9336a44ef48ed8c3e91d39bddf13e2eede0))
* **BO-563:** changed nav item location, updated builds to only fire on main ([5b33c7c](https://github.com/betcocorp/bex2.0/commit/5b33c7c306da3481e848d70d97fc5747da1bd60c))


### BREAKING CHANGES

* BEX_LLM_ROUTER_ENABLED now defaults ON and
BEX_LLM_ROUTER_SHADOW_MODE defaults OFF — every environment routes by
the LLM intent classifier with no env setup. The flags invert into
rollback levers (ENABLED=false -> full keyword world; SHADOW_MODE=true
-> classifier logs-and-compares while keyword routes).

Why: "keyword routing" was never one component — it was five
separately-wired behaviors, and prior rounds removed exactly one each.
This removes the rest as deciders:

- Default flip (above): the env-gated rollout meant any environment
  nobody hand-configured (production included) silently stayed on
  keyword routing forever.
- classifyUserIntent's failure fallback no longer consults
  routeUserMessageToSme: a degraded turn routes to the ambiguous
  generalist fallthrough with the reason on the gate record, so
  keyword scoring can never decide a live turn, even on LLM failure.
- B0-514: shouldForceCrossReferenceLookup retired from the default
  path. Cross-reference intent (early-decline suppression, pinned
  round-0 tool_choice, forcedCrossReference) now derives from the
  classifier's own output — intent `recommendations`, or a
  cross-reference suggestedTool (preserving B0-339's product-routed
  xref case). The substring check survives only for turns the
  classifier did not decide (kill-switch/shadow/degraded).
- B0-508 completed: the agent's orchestrator-hint block now receives
  the classifier's intent/confidence/entities instead of raw keyword
  scores whenever the classifier ran.
- /api/v1/orchestrator responses report the decision that actually
  routed the turn (schema-validated), with the keyword pre-route
  demoted to labeled comparison metadata.

Intent taxonomy fix (the user-facing bug): the classifier prompt now
draws a hard line — `recommendations` is strictly competitor
cross-reference (non-Betco product named, wants the Betco equivalent);
"recommend the best product for this job/surface" routes to the
specialist that owns the job; usage/compatibility questions are never
`recommendations`.

Live-verified on pure defaults (no env vars): gym-floor task
recommendation -> floor with no cross-reference machinery; "Can I use
Symplicity Nova on sealed concrete?" -> product; "Betco equivalent to
Spartan GS High Gloss" -> recommendations with competitorBrand
extracted and the forced cross-reference path firing. 600 tests green,
tsc/lint clean.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

# [2.0.0-dev.3](https://github.com/betcocorp/bex2.0/compare/v2.0.0-dev.2...v2.0.0-dev.3) (2026-08-19)


### Bug Fixes

* **B0-560:** drop the dead actions prop usage on PermissionGroupPage ([8fb32cf](https://github.com/betcocorp/bex2.0/commit/8fb32cf923a1ff8ae46fbb185b8f24f55c94568c))

# [2.0.0-dev.2](https://github.com/betcocorp/bex2.0/compare/v2.0.0-dev.1...v2.0.0-dev.2) (2026-08-19)


### Bug Fixes

* **B0-560:** reconcile nav-permission migration with actual live DB state ([115adb6](https://github.com/betcocorp/bex2.0/commit/115adb6b9d9467b8061b86bf995c156a7d1b9e5c))

# [2.0.0-dev.1](https://github.com/betcocorp/bex2.0/compare/v1.2.0-dev.3...v2.0.0-dev.1) (2026-08-19)


* feat(B0-511)!: make LLM intent routing the default and retire keyword routing from every decision path ([43a90e9](https://github.com/betcocorp/bex2.0/commit/43a90e97d83b7c0c73232b27a450ebcb7c776f48))


### BREAKING CHANGES

* BEX_LLM_ROUTER_ENABLED now defaults ON and
BEX_LLM_ROUTER_SHADOW_MODE defaults OFF — every environment routes by
the LLM intent classifier with no env setup. The flags invert into
rollback levers (ENABLED=false -> full keyword world; SHADOW_MODE=true
-> classifier logs-and-compares while keyword routes).

Why: "keyword routing" was never one component — it was five
separately-wired behaviors, and prior rounds removed exactly one each.
This removes the rest as deciders:

- Default flip (above): the env-gated rollout meant any environment
  nobody hand-configured (production included) silently stayed on
  keyword routing forever.
- classifyUserIntent's failure fallback no longer consults
  routeUserMessageToSme: a degraded turn routes to the ambiguous
  generalist fallthrough with the reason on the gate record, so
  keyword scoring can never decide a live turn, even on LLM failure.
- B0-514: shouldForceCrossReferenceLookup retired from the default
  path. Cross-reference intent (early-decline suppression, pinned
  round-0 tool_choice, forcedCrossReference) now derives from the
  classifier's own output — intent `recommendations`, or a
  cross-reference suggestedTool (preserving B0-339's product-routed
  xref case). The substring check survives only for turns the
  classifier did not decide (kill-switch/shadow/degraded).
- B0-508 completed: the agent's orchestrator-hint block now receives
  the classifier's intent/confidence/entities instead of raw keyword
  scores whenever the classifier ran.
- /api/v1/orchestrator responses report the decision that actually
  routed the turn (schema-validated), with the keyword pre-route
  demoted to labeled comparison metadata.

Intent taxonomy fix (the user-facing bug): the classifier prompt now
draws a hard line — `recommendations` is strictly competitor
cross-reference (non-Betco product named, wants the Betco equivalent);
"recommend the best product for this job/surface" routes to the
specialist that owns the job; usage/compatibility questions are never
`recommendations`.

Live-verified on pure defaults (no env vars): gym-floor task
recommendation -> floor with no cross-reference machinery; "Can I use
Symplicity Nova on sealed concrete?" -> product; "Betco equivalent to
Spartan GS High Gloss" -> recommendations with competitorBrand
extracted and the forced cross-reference path firing. 600 tests green,
tsc/lint clean.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

# [1.2.0-dev.3](https://github.com/betcocorp/bex2.0/compare/v1.2.0-dev.2...v1.2.0-dev.3) (2026-08-18)


### Bug Fixes

* **B0-511:** make the router cutover survive real-world failure modes ([b764b49](https://github.com/betcocorp/bex2.0/commit/b764b4913e1318978ce5c280192f84ad8cfe7500))

# [1.2.0-dev.2](https://github.com/betcocorp/bex2.0/compare/v1.2.0-dev.1...v1.2.0-dev.2) (2026-08-18)


### Bug Fixes

* **B0-511:** raise router classifier timeout from 800ms to 2500ms ([45ad944](https://github.com/betcocorp/bex2.0/commit/45ad9449258e889b1473e2e228ab6026a4cd47b5))

# [1.2.0-dev.1](https://github.com/betcocorp/bex2.0/compare/v1.1.0...v1.2.0-dev.1) (2026-08-18)


### Features

* **B0-511:** cut LLM router over to live routing when shadow mode is off ([a14385f](https://github.com/betcocorp/bex2.0/commit/a14385fbe0dd5943de3442fdf68d852f655592a0))

# [1.1.0](https://github.com/betcocorp/bex2.0/compare/v1.0.0...v1.1.0) (2026-08-18)


### Features

* **na:** updating build ([81a9402](https://github.com/betcocorp/bex2.0/commit/81a9402f8a8880fcc2f0d7d676eed94ca0a3e96f))

# [1.1.0-staging.1](https://github.com/betcocorp/bex2.0/compare/v1.0.0...v1.1.0-staging.1) (2026-08-18)


### Features

* **na:** updating build ([81a9402](https://github.com/betcocorp/bex2.0/commit/81a9402f8a8880fcc2f0d7d676eed94ca0a3e96f))

# [1.1.0-dev.1](https://github.com/betcocorp/bex2.0/compare/v1.0.0...v1.1.0-dev.1) (2026-08-18)


### Features

* **na:** updating build ([81a9402](https://github.com/betcocorp/bex2.0/commit/81a9402f8a8880fcc2f0d7d676eed94ca0a3e96f))

# 1.0.0 (2026-08-18)


### Bug Fixes

* **api-security:** require NextAuth session on /api/admin/tests/* routes ([52734d0](https://github.com/betcocorp/bex2.0/commit/52734d005712406a008c635e63d509dd58a67870))
* **b0-13:** surface chunk ids for retrieval auditing; investigate missed virus claims ([79d90d4](https://github.com/betcocorp/bex2.0/commit/79d90d490f2984406da60039fe23b344b6cb85b5))
* **b0-244:** undefined `KnowledgeChunk` type → `MarkdownChunk` ([27f60b2](https://github.com/betcocorp/bex2.0/commit/27f60b2cadf239d56301adb5eb55830e93cfffb7))
* **b0-272:** prose fallback for efficacy questions + tokenized product-name resolver ([534a9ad](https://github.com/betcocorp/bex2.0/commit/534a9ad59b53dc5b719875fc21939564da49b863))
* **b0-272:** stop hard-filtering scope:'all' retrieval by inferred section_type ([1716acb](https://github.com/betcocorp/bex2.0/commit/1716acb1dd3c853b4a3ce24a9524494907900330))
* **b0-284-hotfix:** restore chunk_sds_document_text TABLE signature ([b0926d6](https://github.com/betcocorp/bex2.0/commit/b0926d6d56f841692ff6d46c2a082d501b013f28))
* **B0-462:** pin pnpm 11 for the release workflow ([bd61dd9](https://github.com/betcocorp/bex2.0/commit/bd61dd96b4b1f00e116f19dde8c6d505aef72d76))
* **database:** add RLS policies to security-less tables & document view security [B0-284, B0-285] ([cb2d432](https://github.com/betcocorp/bex2.0/commit/cb2d432e9997e9a411393f5ef0aa62002ab71c27))
* **efficacy:** make structured efficacy answers work end-to-end ([3425a92](https://github.com/betcocorp/bex2.0/commit/3425a9243fc4ea105c4d703d7d3cf6433009ed32))
* for duplicate key ([748681b](https://github.com/betcocorp/bex2.0/commit/748681b6e2cdda5c523adf9b5c84a3dc80a20249))
* keep the service-token path open on /api/bex/workflow-runs/[id] ([1565177](https://github.com/betcocorp/bex2.0/commit/1565177a3134469d9e044a483524417d4b945c1b))
* **knowledge:** fall back to generic AWS read keys for retool-360 (B0-187) ([080f893](https://github.com/betcocorp/bex2.0/commit/080f89333beb18e1116562c10894abec81a38d33))
* **knowledge:** report ingested status from real chunk counts (B0-188) ([0988352](https://github.com/betcocorp/bex2.0/commit/098835212543c8b434580a02b446d7b8da2a0d6d))
* **migrations:** drop all function overloads before recreate [B0-284] ([e0768a9](https://github.com/betcocorp/bex2.0/commit/e0768a98e5474514704d6bb81dd44536c31adf9f))
* **migrations:** wrap bare RAISE in DO block [B0-284] ([dffc690](https://github.com/betcocorp/bex2.0/commit/dffc690d05164a37187a501d5865159bbfabd08f))
* **na:** let BEX_DISABLE_CONFIDENCE_GATING also bypass regulated-claim grounding and chemistry-mismatch ([d35b0bb](https://github.com/betcocorp/bex2.0/commit/d35b0bb5e9486f1c555ba5f8bc4071469c0228ad))
* **na:** remove duplicate PERMISSIONS keys causing TS1117 and permission-check breakage ([629b54f](https://github.com/betcocorp/bex2.0/commit/629b54f1611a3583b4114a562b26476a703e5bdc))
* **rag:** add filter_product_key to match_corpus_chunks(_hybrid) [B0-250 correction] ([3478014](https://github.com/betcocorp/bex2.0/commit/3478014d2258af8ea3afd7cb4f0f12a9d832cb6d))
* **rag:** correct overload drops for match_product_chunks functions [B0-281] ([a6c688e](https://github.com/betcocorp/bex2.0/commit/a6c688e3fefa299f9b0f52d4d1aa376ffddb482b))
* **rag:** disambiguate dilution_code='0' sentinel into RTU vs missing [B0-265] ([72a5e2d](https://github.com/betcocorp/bex2.0/commit/72a5e2dc1d1eb34746f8f06e14257c55ac3c1569))
* **rag:** disambiguate match_product_chunks_hybrid overload (42725) ([00ef5e6](https://github.com/betcocorp/bex2.0/commit/00ef5e685358f0bbaa068a7c957973d7cacc3260))
* **rag:** drop match_product_chunks overloads before audit [B0-281] ([8fab804](https://github.com/betcocorp/bex2.0/commit/8fab8041b583f69d94281d877ffbf5e54fea5937))
* **rag:** raise statement_timeout on hybrid match RPCs (B0-217) ([df0f156](https://github.com/betcocorp/bex2.0/commit/df0f15654582f74975137dd5fa6bcb563c44c2d3))
* **rag:** stop empty heading-only knowledge chunks from being embedded ([7059665](https://github.com/betcocorp/bex2.0/commit/70596659414360ad7dd410aabc8afa5a461cc3fb))
* **rec:** don't let a validator-revision refusal overwrite a good answer ([fbf644d](https://github.com/betcocorp/bex2.0/commit/fbf644de79c99cdbeeaac989afe84453049b753c))
* **rec:** ground competitor by chemistry + search by capability on cross-ref miss ([659ec92](https://github.com/betcocorp/bex2.0/commit/659ec929d8d49ed8998c36b37edbe5adcb5fb519)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333) [#1](https://github.com/betcocorp/bex2.0/issues/1)
* **rec:** stop forcing the validator on the recommendations route (it was nuking answers) ([f4a6d3e](https://github.com/betcocorp/bex2.0/commit/f4a6d3e367789713581d64ba3597aa02f753b234))
* **rec:** stop stapling a comparable-product headline onto a decline; force validator on rec route ([475d062](https://github.com/betcocorp/bex2.0/commit/475d0623f52d6b52551816a71537860e526fcaa3))
* **rec:** validator must not reject/overwrite a cross-reference recommendation ([3b6c197](https://github.com/betcocorp/bex2.0/commit/3b6c197f5a98358d604543d8fa45e25802d49f3d))
* **tests,rag:** grader decline detection, per-run model, hybrid + knowledge/label scopes ([5c44d6e](https://github.com/betcocorp/bex2.0/commit/5c44d6e07b8366bf1ab9863c1c0c5f793ba8cde2))
* un-ignore src/supabase so new migrations are actually tracked ([8d97504](https://github.com/betcocorp/bex2.0/commit/8d97504f7461b26a105debbd642f00bef957ffb2))


### Features

* add initial app code ([9d5bfa1](https://github.com/betcocorp/bex2.0/commit/9d5bfa1c303462d9face65303fc5029607f08ecf))
* added api test for calling web search tool using new token system ([a5fde6c](https://github.com/betcocorp/bex2.0/commit/a5fde6c946200c1b46fdb09f2757ad434b23a4f9))
* added mew chart ([4718a85](https://github.com/betcocorp/bex2.0/commit/4718a850befbd77c7e05d55595b053f5041c82b1))
* added more shadcn components ([ba27c26](https://github.com/betcocorp/bex2.0/commit/ba27c26b43620ecf8498495490750aca939c0273))
* adding auth ([45e1e5d](https://github.com/betcocorp/bex2.0/commit/45e1e5d466d71ce070fbe4836929ceed416c5ded))
* adding failed queue ([4b627f6](https://github.com/betcocorp/bex2.0/commit/4b627f6a6c0913bf082ca5b2151a87da647931f9))
* adding initial routing and orchestration ([766ae4c](https://github.com/betcocorp/bex2.0/commit/766ae4cde2f9d90a6668f31a52c9c6864287d3fb))
* adding more code to customize logic and functionality ([fa96e4c](https://github.com/betcocorp/bex2.0/commit/fa96e4c9aa8961dcbf1d738e2272340a78809b9f))
* adding more reporting and observability to the search ([29d7374](https://github.com/betcocorp/bex2.0/commit/29d7374fdf8dc6bb47f2c3d70c6d2cbad7a4af16))
* adding more reporting fine tuning. Adding other funcctionality to support workflow along with additional reporting ([b5b24fe](https://github.com/betcocorp/bex2.0/commit/b5b24fe944f92c331416d83931af346b3a07dbd7))
* adding more ui and refining views further ([2fff2b5](https://github.com/betcocorp/bex2.0/commit/2fff2b5779b6866d1ee39ff6a07b5678fb345552))
* adding sentry ([e2a0030](https://github.com/betcocorp/bex2.0/commit/e2a00309f2eeecf52e96efcd773afd7a9ef58b63))
* adding variable similarity threshold to search ([8a15332](https://github.com/betcocorp/bex2.0/commit/8a1533206649ffab7b6c035033fc9a214d95026a))
* **admin:** add Web search card to the /admin/tools landing page ([421361e](https://github.com/betcocorp/bex2.0/commit/421361e86ecdf18660210d366d4495f56427a8d4))
* **admin:** cached web-search results table in /admin/tools/web-search (B0-109) ([adb321d](https://github.com/betcocorp/bex2.0/commit/adb321d92d66d9881abece931e6494834e2f297a))
* **admin:** Orphan Monitor + product-line backfill migration [B0-267] ([d7b193d](https://github.com/betcocorp/bex2.0/commit/d7b193d5eb176fce0a2c78bcb1dfa4989975af92))
* **admin:** show web-search cache duration in Cached results subtext ([9b3f8e7](https://github.com/betcocorp/bex2.0/commit/9b3f8e7e5833d547474147ca2f03ea74f3a62636))
* **api-security:** admin projects list + create wizard (B0-116) ([4aff4d2](https://github.com/betcocorp/bex2.0/commit/4aff4d2c784df6404a2503a56ced6237e10a782e))
* **api-security:** API analytics dashboard (B0-120) ([7a88b13](https://github.com/betcocorp/bex2.0/commit/7a88b137aefb5f3200bdfb3aaffaa86b95b5aee4))
* **api-security:** app detail — tokens, rotation, kill switch, rate limit (B0-118) ([6227e1b](https://github.com/betcocorp/bex2.0/commit/6227e1bfd053c9965d5d58c903540308b71ab575))
* **api-security:** enforce per-client token on all /api/v1/* + delete legacy auth (B0-115) ([48cdf14](https://github.com/betcocorp/bex2.0/commit/48cdf14e78fca6553f8f6a7b0b347e5ed53af651))
* **api-security:** per-app rate limiting (429 + Retry-After) (B0-119) ([31fe4c3](https://github.com/betcocorp/bex2.0/commit/31fe4c386f25b1dc11bd5641c3ea45ff8a5fd08b))
* **api-security:** per-request logging + last-used tracking for /api/v1/* (B0-117) ([4e1d942](https://github.com/betcocorp/bex2.0/commit/4e1d942e0c3a80af868ede76edecf1e100a58762))
* **api-security:** project detail — apps, add app, kill switch (B0-130) ([9893c31](https://github.com/betcocorp/bex2.0/commit/9893c31be3095527d748f38af35db2671920ebd8))
* **api-security:** require NextAuth session on all /api/bex/* routes (B0-114) ([c1692d4](https://github.com/betcocorp/bex2.0/commit/c1692d4b4a61c6d141306918c846e59efe3ecc84))
* **api-security:** thread LLM token usage into request log (B0-117) ([5d1fb29](https://github.com/betcocorp/bex2.0/commit/5d1fb293220d2dc41a860b6f6f253d77bc7fa1ac))
* **api:** add /api/v1/tools registry + wire web-search into withApiV1 [B0-241/B0-242] ([73a8236](https://github.com/betcocorp/bex2.0/commit/73a8236db24b93bb25441a8605f219da6de0be26))
* **api:** expose web search as a client-authenticated v1 tool ([789df5c](https://github.com/betcocorp/bex2.0/commit/789df5c5461503a9cace9c9802b7be382407b6b7))
* B0-183 deterministic web-search fallback on cross-reference miss ([ee4b879](https://github.com/betcocorp/bex2.0/commit/ee4b879dd964dbc528b94f05792b76dc65de17fe))
* **B0-318,B0-319,B0-320,B0-321:** capture and chart time-to-first-token for test runs ([c3bfb16](https://github.com/betcocorp/bex2.0/commit/c3bfb16f17591d3ffaf1dbe00c3e629ef6a01489))
* **B0-349:** persist pre-validator draft answer on every workflow run ([d7f557e](https://github.com/betcocorp/bex2.0/commit/d7f557e38967a8e9828f0c1f5a34aded3b62959f))
* **B0-398:** add prompt-version chips to run header, runs list, and item rows ([7f7e47e](https://github.com/betcocorp/bex2.0/commit/7f7e47e139198fc8f63cfead2e609f04a333fbbf))
* **B0-399:** distinguish four run-trace empty states, centralize search-run extractors ([210f1e5](https://github.com/betcocorp/bex2.0/commit/210f1e531479b718c7435d4edfc0a3638cebb3ce))
* B0-448 conversation source column, bex.chat.view-all, test-run backfill ([932b4bd](https://github.com/betcocorp/bex2.0/commit/932b4bd8294ce062b7d884a1ecec871dbebeb8b6))
* **B0-462:** add semantic-release versioning CI for main/staging/dev ([38841f0](https://github.com/betcocorp/bex2.0/commit/38841f09bf234bbca838b8760726a476f353f045))
* **B0-462:** permissions and minor styling ([80f715f](https://github.com/betcocorp/bex2.0/commit/80f715f0791504867ff48d72a8dd34631188f586))
* **b0-95:** recommendation review & verification queue admin UI ([5c9bdd8](https://github.com/betcocorp/bex2.0/commit/5c9bdd8d580e926177af57e37887c8f2de3af235))
* **b0-96:** promote verified recommendations into fast-path xref + metrics ([4717094](https://github.com/betcocorp/bex2.0/commit/4717094a75acc2500f4e1045fc884bae4f35fa18))
* **b0-97:** threshold calibration tooling + document the real ground-truth gap ([b7eacfc](https://github.com/betcocorp/bex2.0/commit/b7eacfc1d5aaf7428828be46c8fc4c68c6d252c1))
* BO-114 ([e602c21](https://github.com/betcocorp/bex2.0/commit/e602c215f482e3b9e9fd9dd26df3c5be9346c340))
* **BO-304:** Efficacy ingestion ui reworked the ui to make more sense ([2ad40ea](https://github.com/betcocorp/bex2.0/commit/2ad40ead07423706ab800725abb9d890a7d395ab))
* BO-99 ([49c93c0](https://github.com/betcocorp/bex2.0/commit/49c93c07600db5cce3f2e3fd72a02ba0eb336598))
* **category:** admin curation UI for product→category links (B0-36) ([181e08a](https://github.com/betcocorp/bex2.0/commit/181e08a244bd6bcb1369ce4f4f08dfc58892b7b4))
* **category:** authoritative product↔category linker from betco.com scrape (B0-34) ([ba2f7fa](https://github.com/betcocorp/bex2.0/commit/ba2f7fa7dd0e961cae7e9abf4051241df633c886))
* **category:** category resolver — query -> taxonomy node + confidence (B0-27) ([809f107](https://github.com/betcocorp/bex2.0/commit/809f10763f3e1a0accb0c584e3a45043f62cc227))
* **category:** category-first router + agent tool + routing telemetry (B0-29/B0-30/B0-31) ([8c80b37](https://github.com/betcocorp/bex2.0/commit/8c80b37f22a151bec264543bc0121acc9d85ac12))
* **category:** continuous delta sync of product→category links (B0-37) ([40837d9](https://github.com/betcocorp/bex2.0/commit/40837d911642e6cd817da1b0c400f2b0964654e9))
* **category:** cross-validation report vs legacy + live site (B0-38) ([8ee2e98](https://github.com/betcocorp/bex2.0/commit/8ee2e989811b56c38b8ecf30f577a653a9e14acb))
* **category:** DB-backed taxonomy retrieval — query -> node -> products (B0-28, B0-33/B0-34 wiring) ([d1b753a](https://github.com/betcocorp/bex2.0/commit/d1b753aafc16b2d6a13675f7bd0f06f265cf4fd8))
* **category:** LLM classifier for unlinked/low-confidence prod-lines (B0-35) ([5621f68](https://github.com/betcocorp/bex2.0/commit/5621f68aca5f7233d8a51d6616bb64c87d18ce49))
* **category:** seed exact betco.com taxonomy + segregate by source (B0-33) ([9ea119d](https://github.com/betcocorp/bex2.0/commit/9ea119dc38a80ba850559a243255355404413163))
* chore cleaning up code ([bfdc4b1](https://github.com/betcocorp/bex2.0/commit/bfdc4b1e4cac10e167d1d082df161b0b16126e83))
* cleaning up ui ([856ba40](https://github.com/betcocorp/bex2.0/commit/856ba40b39c36d2260b2a7346e87eccf635e767b))
* consolidated some ui, abstracted utilities, abstracted agent definition for sanity ([1c3071e](https://github.com/betcocorp/bex2.0/commit/1c3071e67409096b701ebdc562600c23f9557b1c))
* consolidated the two cross reference pages into one with tabs ([9e53980](https://github.com/betcocorp/bex2.0/commit/9e5398069f1daef61ca5125f0e73d38b25a39f0a))
* continuing to refine context and document corpus structuring ([eee4555](https://github.com/betcocorp/bex2.0/commit/eee45559b013b851ccb23baab81d6e15b0e70eed))
* converted all code to utilize 3072 embedding over 1536 ([ea3cf11](https://github.com/betcocorp/bex2.0/commit/ea3cf11998077d3b5cc233e8ed445516f53758c7))
* converting embeddings to use 3000+ dimensions ([afc7dd2](https://github.com/betcocorp/bex2.0/commit/afc7dd2274e3f5885ef41236f5b009127aa26afa))
* download timeline json, fix corpus inex, minor ui changes ([4f180bd](https://github.com/betcocorp/bex2.0/commit/4f180bda71d8c23b22ce1d74c3a85978b8fb1803))
* **efficacy/labels:** generalize ingestion pipeline, add chunking RPC, schema, retrieval enhancements [B0-227-238, B0-256-283] ([47ab061](https://github.com/betcocorp/bex2.0/commit/47ab0619d45df00c8f2b057048ae2f1f4154c645))
* **efficacy/tools:** implement deterministic dilution lookup with RAG database integration [B0-288] ([67d23b5](https://github.com/betcocorp/bex2.0/commit/67d23b5e83c17986ac0dc3146feb3e05d87f35f7))
* **efficacy:** cross-check and enrich the 70 converted markdown files [B0-224] ([9e40736](https://github.com/betcocorp/bex2.0/commit/9e40736c56389f996aae43921e574f86a4309d53))
* **efficacy:** new document_kind='efficacy' RAG pipeline, crosswalk, citation [B0-227..238] ([3473f11](https://github.com/betcocorp/bex2.0/commit/3473f1174cf02568073e0bd1c378aa6756a6e12b))
* **efficacy:** parse Master Efficacy Version Data into a structured table [B0-223] ([2cd8db9](https://github.com/betcocorp/bex2.0/commit/2cd8db9b4ab741e6c24c545f26e5b5ea7ad428e3))
* enhanced query tuning ([0bb87ca](https://github.com/betcocorp/bex2.0/commit/0bb87cad0560a96c14215866152d6bf06a558c4b))
* enriching data and updating RAG system ([59f118f](https://github.com/betcocorp/bex2.0/commit/59f118f15761626b479a5a8f0c9cda3c89dbe244))
* expand eval refusal detection and add product category tools ([c6724f8](https://github.com/betcocorp/bex2.0/commit/c6724f80772ac7ab8143d0e28ca9f919172f3686))
* expanding the rag search results to be include more inclusive data rather than being fragmented ([53b5050](https://github.com/betcocorp/bex2.0/commit/53b50501d708e16dbf4b5b2f2916bcda9756c361))
* ingesting more efficacy docs, fixing bugs from migration and resolving new efficacy mappings ([2178dd9](https://github.com/betcocorp/bex2.0/commit/2178dd9146f4c709f511202bfdf11ad0f8c5c5ff))
* ingestion of label data ([36a73e4](https://github.com/betcocorp/bex2.0/commit/36a73e443778b49984791ad3aeb9d381eee4602a))
* knowledge base ([0012449](https://github.com/betcocorp/bex2.0/commit/0012449ac739d93e366fc89661517b69e07fc438))
* **knowledge:** admin ingest panel for v1 markdown corpus (B0-187/188/189/190) ([4509adb](https://github.com/betcocorp/bex2.0/commit/4509adb56a9033658bc69741c476c0260dfdff79))
* **knowledge:** markdown-ingest foundation — S3 read, discovery, chunker ([4ffc172](https://github.com/betcocorp/bex2.0/commit/4ffc1722800ad55cfc21eb0af54481b1aac101a4))
* **labels:** validator guardrails, exact lookup tool, citations, discontinued filter [B0-257] ([25a1559](https://github.com/betcocorp/bex2.0/commit/25a155998bc0d7277abebad52743dbb9da704d96))
* migrating the remaining items to vercel ([634e9d3](https://github.com/betcocorp/bex2.0/commit/634e9d33777b88181ee06357e74e5ad661fa29df))
* migration and pipeline remapping ([e283757](https://github.com/betcocorp/bex2.0/commit/e2837578dd80ca7331cc15066a559b7c1feef455))
* minor updates for test runner ui additions ([778c175](https://github.com/betcocorp/bex2.0/commit/778c175d0041256ff74177360fdf043401f667ff))
* **orphans:** view full underlying record from the orphan queue ([d819c0e](https://github.com/betcocorp/bex2.0/commit/d819c0ec62234271c7e5efa244abc676c30e6b0e))
* performance enhancements ([7b5e06d](https://github.com/betcocorp/bex2.0/commit/7b5e06d8bcd345cab0bf105fac0e7c4b0787bbb0))
* persist anlysis of runs to db ([49c3e94](https://github.com/betcocorp/bex2.0/commit/49c3e9412c09a3e43e69c585f2dcd4f9a9498467))
* **rag/products/efficacy:** complete B0-279/281/284/286/287/289 work ([f8c67ef](https://github.com/betcocorp/bex2.0/commit/f8c67ef27a2545b6afa5fce8e2e57bc44c4aa7b2))
* **rag:** activate filter_product_key in retrieval query resolver [B0-250] ([b857e9b](https://github.com/betcocorp/bex2.0/commit/b857e9b9d2294f9a43f328fcbb0b660cff5334b6))
* **rag:** backfill active products into rag.entity as product-tier entities [B0-246] ([572ab24](https://github.com/betcocorp/bex2.0/commit/572ab244966b7b2dd90e47fb77087ae95beecefd))
* **rag:** classify product_application from category taxonomy [B0-263] ([e6735e5](https://github.com/betcocorp/bex2.0/commit/e6735e5b9e8037b8199603f826ce5b308dc9df7e))
* **rag:** enable cross-encoder reranking on product-support retrieval path [B0-280] ([8a09582](https://github.com/betcocorp/bex2.0/commit/8a095821e01a22b51f983ca26cedb67c7f2f9a72))
* **rag:** extract dilution values from directions text for 34 lines [B0-264] ([6da953e](https://github.com/betcocorp/bex2.0/commit/6da953e3ccb6c0d881c72ddcc5fe4cbd7726f4d8))
* **rag:** link active product entities to their product-line parents [B0-247] ([717c698](https://github.com/betcocorp/bex2.0/commit/717c69864a90f61ed656dae40f5b15d4bf909736))
* **rag:** link unambiguous label documents to active product entities [B0-249] ([bc809d1](https://github.com/betcocorp/bex2.0/commit/bc809d135ceee3ae71bb1a56bab87a9d0e05a848))
* **rag:** seed SKU/InvtID aliases for active products [B0-248] ([95fb31c](https://github.com/betcocorp/bex2.0/commit/95fb31c8ac61450c7a3b54ed4ac9097819b6e6bc))
* **rag:** tune HNSW ef_search + candidate pools; lock down maintenance RPC grants & search_path [B0-278/282/283] ([abeeb80](https://github.com/betcocorp/bex2.0/commit/abeeb80f832cd28b8fc118b50b6da564801eaeaf))
* rearranged ingestion ui to make more sense in additional ingestion pages and removed working docs from claude ([fc860f1](https://github.com/betcocorp/bex2.0/commit/fc860f1c94c2431334ad641e690773b1af529ab8))
* **rec-3:** curated cross-reference override — Spartan BNC-15 → Betco Triforce (B0-46/B0-76) ([6d53017](https://github.com/betcocorp/bex2.0/commit/6d53017dee0363d49cd1fde7d13f14de7e95a6c7)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333)
* **rec:** competitive analysis + up to 2 alternatives for a curated recommendation ([6ce90bd](https://github.com/betcocorp/bex2.0/commit/6ce90bd68ee3a74be5ea5e287f7b25ff7753d2b2))
* **rec:** deterministic cross-reference override safety-net (make Triforce land) ([42ca9fe](https://github.com/betcocorp/bex2.0/commit/42ca9fe89f3a130894ed8cb040dae742032b2bbd))
* Recommendations SME agent + competitor cross-reference engine (B0-43/44/47/49/50/51) ([02af888](https://github.com/betcocorp/bex2.0/commit/02af8884d7db21ce8796936f77b9c76d35ec8497)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333)
* **recommendations:** confidence scoring + configurable threshold gate (B0-88) ([fa5b0d1](https://github.com/betcocorp/bex2.0/commit/fa5b0d1a5c95c86556a28b6f2239334c4c6c5e65))
* **recommendations:** cross-reference recommendation prompt template + output schema (B0-90) ([d1a11fa](https://github.com/betcocorp/bex2.0/commit/d1a11fa568637b300b6bf54bf9de5e5f909ba061))
* **recommendations:** guardrails for the web-grounded recommendation (B0-91) ([1f82a40](https://github.com/betcocorp/bex2.0/commit/1f82a40e5c3b447876c3b17b4f44e146b98a2968))
* **recommendations:** LLM competitor-spec enrichment on the heuristic extractor (B0-86) ([9ae36e5](https://github.com/betcocorp/bex2.0/commit/9ae36e576e35d42b702321a49e4af82f3acb1fc3))
* **recommendations:** persist every recommendation (answered + declined) (B0-89) ([87bf45d](https://github.com/betcocorp/bex2.0/commit/87bf45dcb634f37fda82dca7c4e2423c58f196c7))
* **recommendations:** rag cross-reference recommendation tables (B0-82) ([e46f57a](https://github.com/betcocorp/bex2.0/commit/e46f57a0722d3f1a893c0c98271696ac86841be6))
* **recommendations:** recommendation API endpoint + tester UI (B0-94) ([762c1e3](https://github.com/betcocorp/bex2.0/commit/762c1e3baec875928af21c3da9601b31c43b9328))
* **recommendations:** recommendCrossReference() orchestrator, legacy-first + web fallback (B0-85) ([d812f9f](https://github.com/betcocorp/bex2.0/commit/d812f9fedd61cb6e694cf19bdf26ff3f20d01eac))
* **recommendations:** retrieve N Betco candidates from the enriched spec (B0-87) ([09778ce](https://github.com/betcocorp/bex2.0/commit/09778ce9e761d7a76efe52601c50b3749359edd4))
* **recommendations:** web-search cost/domain/rate guardrails (B0-92) ([ebaf14e](https://github.com/betcocorp/bex2.0/commit/ebaf14ebd989b141e57591a49a5b80b8b41be677))
* **recommendations:** wire recommend_cross_reference agent tool into the workflow (B0-93) ([217db0b](https://github.com/betcocorp/bex2.0/commit/217db0b42fe4e60b6587b81bd84ae37ad6afe90f))
* **recommendations:** Zod contracts + repository for cross-reference recommendations (B0-83) ([543958d](https://github.com/betcocorp/bex2.0/commit/543958df135300873d2d722826b704a2ea0468b4))
* reconciling new data from 1.0 ([8203229](https://github.com/betcocorp/bex2.0/commit/8203229d5a37677a6cc1352751524554847024f9))
* restructuring chunks for embedding ([9d847d9](https://github.com/betcocorp/bex2.0/commit/9d847d9967dbc260b66e443026422d0f2c0c4b6b))
* **retrieval:** fetch structured product facts + attach to query result (B0-195) ([07bfa7c](https://github.com/betcocorp/bex2.0/commit/07bfa7c645a78d8932b1005c43fc7ed72bf5cd1b))
* **retrieval:** intent-driven curation knobs (B0-201) ([d7c5493](https://github.com/betcocorp/bex2.0/commit/d7c5493937e409fc7c17a5a167384b6f8aa34c28))
* **retrieval:** near-duplicate suppression across sources [B0-257] ([9fa2cfc](https://github.com/betcocorp/bex2.0/commit/9fa2cfc1fc8c974ba65fd224a1df375352c6c158))
* **retrieval:** product alias table resolution (B0-200) ([b3a7b7f](https://github.com/betcocorp/bex2.0/commit/b3a7b7f8041cbdfe85f401820a7ea7dd90bc1112))
* **retrieval:** surface knowledge chunks in curated results (B0-191) ([e162eb0](https://github.com/betcocorp/bex2.0/commit/e162eb0754c671a78087657003cd9d839cbe2e5e))
* **sds:** scope SDS corpus discovery to policy + content-based language check [B0-243] ([83b3636](https://github.com/betcocorp/bex2.0/commit/83b36368b78d12edcdafa6a6581ecf7716ba30af))
* starting api security work ([ab270e4](https://github.com/betcocorp/bex2.0/commit/ab270e4089c875bba5c0be854e95bf83a59b7a9a))
* test runner suite ([fb517d5](https://github.com/betcocorp/bex2.0/commit/fb517d5b2d6b60b3e1bc631487686bcd9b997fb9))
* **tools:** get_efficacy_data fact-only tool + route dilution/kill-claim intents (B0-197) ([894e33b](https://github.com/betcocorp/bex2.0/commit/894e33b0d1f4f005992cf74374f32b439bba5693))
* **tools:** ground answers on structured facts (B0-196) ([3e3a9a3](https://github.com/betcocorp/bex2.0/commit/3e3a9a31ce930403c8f8c67537b729d7ae97f315))
* tuning the search to optimize both for product data and sds ([6c5d4b5](https://github.com/betcocorp/bex2.0/commit/6c5d4b52678fca96f47f4e9d679e961df0d2d51b))
* tweaking workflows and updating ui responses ([da92099](https://github.com/betcocorp/bex2.0/commit/da92099391273810cbf7d1d4cbed0ffffff9f646))
* ui feature enhancements, new tool product cross reference tool ([f79705f](https://github.com/betcocorp/bex2.0/commit/f79705f87c3e628abd1ce93f2b0332582140c0dc))
* updating code based on docs and specifications already developed ([5b5dcda](https://github.com/betcocorp/bex2.0/commit/5b5dcdae1e04e47a073bf765b16aa81d0ccb29bc))
* updating data, add prompt, remove ([4af379d](https://github.com/betcocorp/bex2.0/commit/4af379db6c8b7f79912e9f00c3de62bb1f495339))
* vercel migration minor ui changes ([e35820a](https://github.com/betcocorp/bex2.0/commit/e35820ad0a6b6bd844bfa17d70644459495af21e))
* web search caching + competitor-spec extraction (B0-55, B0-54) ([28d582b](https://github.com/betcocorp/bex2.0/commit/28d582b2bb4b5bcafa0058573ec5e05eecdad73e))
* web search capability + admin test harness (B0-70) ([485c3d0](https://github.com/betcocorp/bex2.0/commit/485c3d00c4be7e81ee4cc0da45f623d88e0e69ad))
* **websearch:** durable DB-backed response cache (memory -> DB -> provider) ([1a0770b](https://github.com/betcocorp/bex2.0/commit/1a0770b5c15950817897e517fcfa93608ea8d0d6))
* **websearch:** external citation surface in agent output (WEB-6) ([8b80ad3](https://github.com/betcocorp/bex2.0/commit/8b80ad3ac8e190705b01067dae5ef398db90ae12))
* **websearch:** source-trust policy (WEB-2) + guardrails/cost controls (WEB-5) ([7b64c95](https://github.com/betcocorp/bex2.0/commit/7b64c95ce2783bd4162b0d69f0e1d50d82b163cf))
* working on data migration and initial vector embeddings ([59db37e](https://github.com/betcocorp/bex2.0/commit/59db37eed541b4bc06688e8b36a3b95ec21af2b2))
* working on first implementation of sub agents ([5c2fb3d](https://github.com/betcocorp/bex2.0/commit/5c2fb3db56f75587945355439982617149cf0300))

# 1.0.0 (2026-08-17)


### Bug Fixes

* **api-security:** require NextAuth session on /api/admin/tests/* routes ([52734d0](https://github.com/betcocorp/bex2.0/commit/52734d005712406a008c635e63d509dd58a67870))
* **b0-13:** surface chunk ids for retrieval auditing; investigate missed virus claims ([79d90d4](https://github.com/betcocorp/bex2.0/commit/79d90d490f2984406da60039fe23b344b6cb85b5))
* **b0-244:** undefined `KnowledgeChunk` type → `MarkdownChunk` ([27f60b2](https://github.com/betcocorp/bex2.0/commit/27f60b2cadf239d56301adb5eb55830e93cfffb7))
* **b0-272:** prose fallback for efficacy questions + tokenized product-name resolver ([534a9ad](https://github.com/betcocorp/bex2.0/commit/534a9ad59b53dc5b719875fc21939564da49b863))
* **b0-272:** stop hard-filtering scope:'all' retrieval by inferred section_type ([1716acb](https://github.com/betcocorp/bex2.0/commit/1716acb1dd3c853b4a3ce24a9524494907900330))
* **b0-284-hotfix:** restore chunk_sds_document_text TABLE signature ([b0926d6](https://github.com/betcocorp/bex2.0/commit/b0926d6d56f841692ff6d46c2a082d501b013f28))
* **B0-462:** pin pnpm 11 for the release workflow ([bd61dd9](https://github.com/betcocorp/bex2.0/commit/bd61dd96b4b1f00e116f19dde8c6d505aef72d76))
* **database:** add RLS policies to security-less tables & document view security [B0-284, B0-285] ([cb2d432](https://github.com/betcocorp/bex2.0/commit/cb2d432e9997e9a411393f5ef0aa62002ab71c27))
* **efficacy:** make structured efficacy answers work end-to-end ([3425a92](https://github.com/betcocorp/bex2.0/commit/3425a9243fc4ea105c4d703d7d3cf6433009ed32))
* for duplicate key ([748681b](https://github.com/betcocorp/bex2.0/commit/748681b6e2cdda5c523adf9b5c84a3dc80a20249))
* keep the service-token path open on /api/bex/workflow-runs/[id] ([1565177](https://github.com/betcocorp/bex2.0/commit/1565177a3134469d9e044a483524417d4b945c1b))
* **knowledge:** fall back to generic AWS read keys for retool-360 (B0-187) ([080f893](https://github.com/betcocorp/bex2.0/commit/080f89333beb18e1116562c10894abec81a38d33))
* **knowledge:** report ingested status from real chunk counts (B0-188) ([0988352](https://github.com/betcocorp/bex2.0/commit/098835212543c8b434580a02b446d7b8da2a0d6d))
* **migrations:** drop all function overloads before recreate [B0-284] ([e0768a9](https://github.com/betcocorp/bex2.0/commit/e0768a98e5474514704d6bb81dd44536c31adf9f))
* **migrations:** wrap bare RAISE in DO block [B0-284] ([dffc690](https://github.com/betcocorp/bex2.0/commit/dffc690d05164a37187a501d5865159bbfabd08f))
* **na:** let BEX_DISABLE_CONFIDENCE_GATING also bypass regulated-claim grounding and chemistry-mismatch ([d35b0bb](https://github.com/betcocorp/bex2.0/commit/d35b0bb5e9486f1c555ba5f8bc4071469c0228ad))
* **na:** remove duplicate PERMISSIONS keys causing TS1117 and permission-check breakage ([629b54f](https://github.com/betcocorp/bex2.0/commit/629b54f1611a3583b4114a562b26476a703e5bdc))
* **rag:** add filter_product_key to match_corpus_chunks(_hybrid) [B0-250 correction] ([3478014](https://github.com/betcocorp/bex2.0/commit/3478014d2258af8ea3afd7cb4f0f12a9d832cb6d))
* **rag:** correct overload drops for match_product_chunks functions [B0-281] ([a6c688e](https://github.com/betcocorp/bex2.0/commit/a6c688e3fefa299f9b0f52d4d1aa376ffddb482b))
* **rag:** disambiguate dilution_code='0' sentinel into RTU vs missing [B0-265] ([72a5e2d](https://github.com/betcocorp/bex2.0/commit/72a5e2dc1d1eb34746f8f06e14257c55ac3c1569))
* **rag:** disambiguate match_product_chunks_hybrid overload (42725) ([00ef5e6](https://github.com/betcocorp/bex2.0/commit/00ef5e685358f0bbaa068a7c957973d7cacc3260))
* **rag:** drop match_product_chunks overloads before audit [B0-281] ([8fab804](https://github.com/betcocorp/bex2.0/commit/8fab8041b583f69d94281d877ffbf5e54fea5937))
* **rag:** raise statement_timeout on hybrid match RPCs (B0-217) ([df0f156](https://github.com/betcocorp/bex2.0/commit/df0f15654582f74975137dd5fa6bcb563c44c2d3))
* **rag:** stop empty heading-only knowledge chunks from being embedded ([7059665](https://github.com/betcocorp/bex2.0/commit/70596659414360ad7dd410aabc8afa5a461cc3fb))
* **rec:** don't let a validator-revision refusal overwrite a good answer ([fbf644d](https://github.com/betcocorp/bex2.0/commit/fbf644de79c99cdbeeaac989afe84453049b753c))
* **rec:** ground competitor by chemistry + search by capability on cross-ref miss ([659ec92](https://github.com/betcocorp/bex2.0/commit/659ec929d8d49ed8998c36b37edbe5adcb5fb519)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333) [#1](https://github.com/betcocorp/bex2.0/issues/1)
* **rec:** stop forcing the validator on the recommendations route (it was nuking answers) ([f4a6d3e](https://github.com/betcocorp/bex2.0/commit/f4a6d3e367789713581d64ba3597aa02f753b234))
* **rec:** stop stapling a comparable-product headline onto a decline; force validator on rec route ([475d062](https://github.com/betcocorp/bex2.0/commit/475d0623f52d6b52551816a71537860e526fcaa3))
* **rec:** validator must not reject/overwrite a cross-reference recommendation ([3b6c197](https://github.com/betcocorp/bex2.0/commit/3b6c197f5a98358d604543d8fa45e25802d49f3d))
* **tests,rag:** grader decline detection, per-run model, hybrid + knowledge/label scopes ([5c44d6e](https://github.com/betcocorp/bex2.0/commit/5c44d6e07b8366bf1ab9863c1c0c5f793ba8cde2))
* un-ignore src/supabase so new migrations are actually tracked ([8d97504](https://github.com/betcocorp/bex2.0/commit/8d97504f7461b26a105debbd642f00bef957ffb2))


### Features

* add initial app code ([9d5bfa1](https://github.com/betcocorp/bex2.0/commit/9d5bfa1c303462d9face65303fc5029607f08ecf))
* added api test for calling web search tool using new token system ([a5fde6c](https://github.com/betcocorp/bex2.0/commit/a5fde6c946200c1b46fdb09f2757ad434b23a4f9))
* added mew chart ([4718a85](https://github.com/betcocorp/bex2.0/commit/4718a850befbd77c7e05d55595b053f5041c82b1))
* added more shadcn components ([ba27c26](https://github.com/betcocorp/bex2.0/commit/ba27c26b43620ecf8498495490750aca939c0273))
* adding auth ([45e1e5d](https://github.com/betcocorp/bex2.0/commit/45e1e5d466d71ce070fbe4836929ceed416c5ded))
* adding failed queue ([4b627f6](https://github.com/betcocorp/bex2.0/commit/4b627f6a6c0913bf082ca5b2151a87da647931f9))
* adding initial routing and orchestration ([766ae4c](https://github.com/betcocorp/bex2.0/commit/766ae4cde2f9d90a6668f31a52c9c6864287d3fb))
* adding more code to customize logic and functionality ([fa96e4c](https://github.com/betcocorp/bex2.0/commit/fa96e4c9aa8961dcbf1d738e2272340a78809b9f))
* adding more reporting and observability to the search ([29d7374](https://github.com/betcocorp/bex2.0/commit/29d7374fdf8dc6bb47f2c3d70c6d2cbad7a4af16))
* adding more reporting fine tuning. Adding other funcctionality to support workflow along with additional reporting ([b5b24fe](https://github.com/betcocorp/bex2.0/commit/b5b24fe944f92c331416d83931af346b3a07dbd7))
* adding more ui and refining views further ([2fff2b5](https://github.com/betcocorp/bex2.0/commit/2fff2b5779b6866d1ee39ff6a07b5678fb345552))
* adding sentry ([e2a0030](https://github.com/betcocorp/bex2.0/commit/e2a00309f2eeecf52e96efcd773afd7a9ef58b63))
* adding variable similarity threshold to search ([8a15332](https://github.com/betcocorp/bex2.0/commit/8a1533206649ffab7b6c035033fc9a214d95026a))
* **admin:** add Web search card to the /admin/tools landing page ([421361e](https://github.com/betcocorp/bex2.0/commit/421361e86ecdf18660210d366d4495f56427a8d4))
* **admin:** cached web-search results table in /admin/tools/web-search (B0-109) ([adb321d](https://github.com/betcocorp/bex2.0/commit/adb321d92d66d9881abece931e6494834e2f297a))
* **admin:** Orphan Monitor + product-line backfill migration [B0-267] ([d7b193d](https://github.com/betcocorp/bex2.0/commit/d7b193d5eb176fce0a2c78bcb1dfa4989975af92))
* **admin:** show web-search cache duration in Cached results subtext ([9b3f8e7](https://github.com/betcocorp/bex2.0/commit/9b3f8e7e5833d547474147ca2f03ea74f3a62636))
* **api-security:** admin projects list + create wizard (B0-116) ([4aff4d2](https://github.com/betcocorp/bex2.0/commit/4aff4d2c784df6404a2503a56ced6237e10a782e))
* **api-security:** API analytics dashboard (B0-120) ([7a88b13](https://github.com/betcocorp/bex2.0/commit/7a88b137aefb5f3200bdfb3aaffaa86b95b5aee4))
* **api-security:** app detail — tokens, rotation, kill switch, rate limit (B0-118) ([6227e1b](https://github.com/betcocorp/bex2.0/commit/6227e1bfd053c9965d5d58c903540308b71ab575))
* **api-security:** enforce per-client token on all /api/v1/* + delete legacy auth (B0-115) ([48cdf14](https://github.com/betcocorp/bex2.0/commit/48cdf14e78fca6553f8f6a7b0b347e5ed53af651))
* **api-security:** per-app rate limiting (429 + Retry-After) (B0-119) ([31fe4c3](https://github.com/betcocorp/bex2.0/commit/31fe4c386f25b1dc11bd5641c3ea45ff8a5fd08b))
* **api-security:** per-request logging + last-used tracking for /api/v1/* (B0-117) ([4e1d942](https://github.com/betcocorp/bex2.0/commit/4e1d942e0c3a80af868ede76edecf1e100a58762))
* **api-security:** project detail — apps, add app, kill switch (B0-130) ([9893c31](https://github.com/betcocorp/bex2.0/commit/9893c31be3095527d748f38af35db2671920ebd8))
* **api-security:** require NextAuth session on all /api/bex/* routes (B0-114) ([c1692d4](https://github.com/betcocorp/bex2.0/commit/c1692d4b4a61c6d141306918c846e59efe3ecc84))
* **api-security:** thread LLM token usage into request log (B0-117) ([5d1fb29](https://github.com/betcocorp/bex2.0/commit/5d1fb293220d2dc41a860b6f6f253d77bc7fa1ac))
* **api:** add /api/v1/tools registry + wire web-search into withApiV1 [B0-241/B0-242] ([73a8236](https://github.com/betcocorp/bex2.0/commit/73a8236db24b93bb25441a8605f219da6de0be26))
* **api:** expose web search as a client-authenticated v1 tool ([789df5c](https://github.com/betcocorp/bex2.0/commit/789df5c5461503a9cace9c9802b7be382407b6b7))
* B0-183 deterministic web-search fallback on cross-reference miss ([ee4b879](https://github.com/betcocorp/bex2.0/commit/ee4b879dd964dbc528b94f05792b76dc65de17fe))
* **B0-318,B0-319,B0-320,B0-321:** capture and chart time-to-first-token for test runs ([c3bfb16](https://github.com/betcocorp/bex2.0/commit/c3bfb16f17591d3ffaf1dbe00c3e629ef6a01489))
* **B0-349:** persist pre-validator draft answer on every workflow run ([d7f557e](https://github.com/betcocorp/bex2.0/commit/d7f557e38967a8e9828f0c1f5a34aded3b62959f))
* **B0-398:** add prompt-version chips to run header, runs list, and item rows ([7f7e47e](https://github.com/betcocorp/bex2.0/commit/7f7e47e139198fc8f63cfead2e609f04a333fbbf))
* **B0-399:** distinguish four run-trace empty states, centralize search-run extractors ([210f1e5](https://github.com/betcocorp/bex2.0/commit/210f1e531479b718c7435d4edfc0a3638cebb3ce))
* B0-448 conversation source column, bex.chat.view-all, test-run backfill ([932b4bd](https://github.com/betcocorp/bex2.0/commit/932b4bd8294ce062b7d884a1ecec871dbebeb8b6))
* **B0-462:** add semantic-release versioning CI for main/staging/dev ([38841f0](https://github.com/betcocorp/bex2.0/commit/38841f09bf234bbca838b8760726a476f353f045))
* **B0-462:** permissions and minor styling ([80f715f](https://github.com/betcocorp/bex2.0/commit/80f715f0791504867ff48d72a8dd34631188f586))
* **b0-95:** recommendation review & verification queue admin UI ([5c9bdd8](https://github.com/betcocorp/bex2.0/commit/5c9bdd8d580e926177af57e37887c8f2de3af235))
* **b0-96:** promote verified recommendations into fast-path xref + metrics ([4717094](https://github.com/betcocorp/bex2.0/commit/4717094a75acc2500f4e1045fc884bae4f35fa18))
* **b0-97:** threshold calibration tooling + document the real ground-truth gap ([b7eacfc](https://github.com/betcocorp/bex2.0/commit/b7eacfc1d5aaf7428828be46c8fc4c68c6d252c1))
* BO-114 ([e602c21](https://github.com/betcocorp/bex2.0/commit/e602c215f482e3b9e9fd9dd26df3c5be9346c340))
* **BO-304:** Efficacy ingestion ui reworked the ui to make more sense ([2ad40ea](https://github.com/betcocorp/bex2.0/commit/2ad40ead07423706ab800725abb9d890a7d395ab))
* BO-99 ([49c93c0](https://github.com/betcocorp/bex2.0/commit/49c93c07600db5cce3f2e3fd72a02ba0eb336598))
* **category:** admin curation UI for product→category links (B0-36) ([181e08a](https://github.com/betcocorp/bex2.0/commit/181e08a244bd6bcb1369ce4f4f08dfc58892b7b4))
* **category:** authoritative product↔category linker from betco.com scrape (B0-34) ([ba2f7fa](https://github.com/betcocorp/bex2.0/commit/ba2f7fa7dd0e961cae7e9abf4051241df633c886))
* **category:** category resolver — query -> taxonomy node + confidence (B0-27) ([809f107](https://github.com/betcocorp/bex2.0/commit/809f10763f3e1a0accb0c584e3a45043f62cc227))
* **category:** category-first router + agent tool + routing telemetry (B0-29/B0-30/B0-31) ([8c80b37](https://github.com/betcocorp/bex2.0/commit/8c80b37f22a151bec264543bc0121acc9d85ac12))
* **category:** continuous delta sync of product→category links (B0-37) ([40837d9](https://github.com/betcocorp/bex2.0/commit/40837d911642e6cd817da1b0c400f2b0964654e9))
* **category:** cross-validation report vs legacy + live site (B0-38) ([8ee2e98](https://github.com/betcocorp/bex2.0/commit/8ee2e989811b56c38b8ecf30f577a653a9e14acb))
* **category:** DB-backed taxonomy retrieval — query -> node -> products (B0-28, B0-33/B0-34 wiring) ([d1b753a](https://github.com/betcocorp/bex2.0/commit/d1b753aafc16b2d6a13675f7bd0f06f265cf4fd8))
* **category:** LLM classifier for unlinked/low-confidence prod-lines (B0-35) ([5621f68](https://github.com/betcocorp/bex2.0/commit/5621f68aca5f7233d8a51d6616bb64c87d18ce49))
* **category:** seed exact betco.com taxonomy + segregate by source (B0-33) ([9ea119d](https://github.com/betcocorp/bex2.0/commit/9ea119dc38a80ba850559a243255355404413163))
* chore cleaning up code ([bfdc4b1](https://github.com/betcocorp/bex2.0/commit/bfdc4b1e4cac10e167d1d082df161b0b16126e83))
* cleaning up ui ([856ba40](https://github.com/betcocorp/bex2.0/commit/856ba40b39c36d2260b2a7346e87eccf635e767b))
* consolidated some ui, abstracted utilities, abstracted agent definition for sanity ([1c3071e](https://github.com/betcocorp/bex2.0/commit/1c3071e67409096b701ebdc562600c23f9557b1c))
* consolidated the two cross reference pages into one with tabs ([9e53980](https://github.com/betcocorp/bex2.0/commit/9e5398069f1daef61ca5125f0e73d38b25a39f0a))
* continuing to refine context and document corpus structuring ([eee4555](https://github.com/betcocorp/bex2.0/commit/eee45559b013b851ccb23baab81d6e15b0e70eed))
* converted all code to utilize 3072 embedding over 1536 ([ea3cf11](https://github.com/betcocorp/bex2.0/commit/ea3cf11998077d3b5cc233e8ed445516f53758c7))
* converting embeddings to use 3000+ dimensions ([afc7dd2](https://github.com/betcocorp/bex2.0/commit/afc7dd2274e3f5885ef41236f5b009127aa26afa))
* download timeline json, fix corpus inex, minor ui changes ([4f180bd](https://github.com/betcocorp/bex2.0/commit/4f180bda71d8c23b22ce1d74c3a85978b8fb1803))
* **efficacy/labels:** generalize ingestion pipeline, add chunking RPC, schema, retrieval enhancements [B0-227-238, B0-256-283] ([47ab061](https://github.com/betcocorp/bex2.0/commit/47ab0619d45df00c8f2b057048ae2f1f4154c645))
* **efficacy/tools:** implement deterministic dilution lookup with RAG database integration [B0-288] ([67d23b5](https://github.com/betcocorp/bex2.0/commit/67d23b5e83c17986ac0dc3146feb3e05d87f35f7))
* **efficacy:** cross-check and enrich the 70 converted markdown files [B0-224] ([9e40736](https://github.com/betcocorp/bex2.0/commit/9e40736c56389f996aae43921e574f86a4309d53))
* **efficacy:** new document_kind='efficacy' RAG pipeline, crosswalk, citation [B0-227..238] ([3473f11](https://github.com/betcocorp/bex2.0/commit/3473f1174cf02568073e0bd1c378aa6756a6e12b))
* **efficacy:** parse Master Efficacy Version Data into a structured table [B0-223] ([2cd8db9](https://github.com/betcocorp/bex2.0/commit/2cd8db9b4ab741e6c24c545f26e5b5ea7ad428e3))
* enhanced query tuning ([0bb87ca](https://github.com/betcocorp/bex2.0/commit/0bb87cad0560a96c14215866152d6bf06a558c4b))
* enriching data and updating RAG system ([59f118f](https://github.com/betcocorp/bex2.0/commit/59f118f15761626b479a5a8f0c9cda3c89dbe244))
* expand eval refusal detection and add product category tools ([c6724f8](https://github.com/betcocorp/bex2.0/commit/c6724f80772ac7ab8143d0e28ca9f919172f3686))
* expanding the rag search results to be include more inclusive data rather than being fragmented ([53b5050](https://github.com/betcocorp/bex2.0/commit/53b50501d708e16dbf4b5b2f2916bcda9756c361))
* ingesting more efficacy docs, fixing bugs from migration and resolving new efficacy mappings ([2178dd9](https://github.com/betcocorp/bex2.0/commit/2178dd9146f4c709f511202bfdf11ad0f8c5c5ff))
* ingestion of label data ([36a73e4](https://github.com/betcocorp/bex2.0/commit/36a73e443778b49984791ad3aeb9d381eee4602a))
* knowledge base ([0012449](https://github.com/betcocorp/bex2.0/commit/0012449ac739d93e366fc89661517b69e07fc438))
* **knowledge:** admin ingest panel for v1 markdown corpus (B0-187/188/189/190) ([4509adb](https://github.com/betcocorp/bex2.0/commit/4509adb56a9033658bc69741c476c0260dfdff79))
* **knowledge:** markdown-ingest foundation — S3 read, discovery, chunker ([4ffc172](https://github.com/betcocorp/bex2.0/commit/4ffc1722800ad55cfc21eb0af54481b1aac101a4))
* **labels:** validator guardrails, exact lookup tool, citations, discontinued filter [B0-257] ([25a1559](https://github.com/betcocorp/bex2.0/commit/25a155998bc0d7277abebad52743dbb9da704d96))
* migrating the remaining items to vercel ([634e9d3](https://github.com/betcocorp/bex2.0/commit/634e9d33777b88181ee06357e74e5ad661fa29df))
* migration and pipeline remapping ([e283757](https://github.com/betcocorp/bex2.0/commit/e2837578dd80ca7331cc15066a559b7c1feef455))
* minor updates for test runner ui additions ([778c175](https://github.com/betcocorp/bex2.0/commit/778c175d0041256ff74177360fdf043401f667ff))
* **orphans:** view full underlying record from the orphan queue ([d819c0e](https://github.com/betcocorp/bex2.0/commit/d819c0ec62234271c7e5efa244abc676c30e6b0e))
* performance enhancements ([7b5e06d](https://github.com/betcocorp/bex2.0/commit/7b5e06d8bcd345cab0bf105fac0e7c4b0787bbb0))
* persist anlysis of runs to db ([49c3e94](https://github.com/betcocorp/bex2.0/commit/49c3e9412c09a3e43e69c585f2dcd4f9a9498467))
* **rag/products/efficacy:** complete B0-279/281/284/286/287/289 work ([f8c67ef](https://github.com/betcocorp/bex2.0/commit/f8c67ef27a2545b6afa5fce8e2e57bc44c4aa7b2))
* **rag:** activate filter_product_key in retrieval query resolver [B0-250] ([b857e9b](https://github.com/betcocorp/bex2.0/commit/b857e9b9d2294f9a43f328fcbb0b660cff5334b6))
* **rag:** backfill active products into rag.entity as product-tier entities [B0-246] ([572ab24](https://github.com/betcocorp/bex2.0/commit/572ab244966b7b2dd90e47fb77087ae95beecefd))
* **rag:** classify product_application from category taxonomy [B0-263] ([e6735e5](https://github.com/betcocorp/bex2.0/commit/e6735e5b9e8037b8199603f826ce5b308dc9df7e))
* **rag:** enable cross-encoder reranking on product-support retrieval path [B0-280] ([8a09582](https://github.com/betcocorp/bex2.0/commit/8a095821e01a22b51f983ca26cedb67c7f2f9a72))
* **rag:** extract dilution values from directions text for 34 lines [B0-264] ([6da953e](https://github.com/betcocorp/bex2.0/commit/6da953e3ccb6c0d881c72ddcc5fe4cbd7726f4d8))
* **rag:** link active product entities to their product-line parents [B0-247] ([717c698](https://github.com/betcocorp/bex2.0/commit/717c69864a90f61ed656dae40f5b15d4bf909736))
* **rag:** link unambiguous label documents to active product entities [B0-249] ([bc809d1](https://github.com/betcocorp/bex2.0/commit/bc809d135ceee3ae71bb1a56bab87a9d0e05a848))
* **rag:** seed SKU/InvtID aliases for active products [B0-248] ([95fb31c](https://github.com/betcocorp/bex2.0/commit/95fb31c8ac61450c7a3b54ed4ac9097819b6e6bc))
* **rag:** tune HNSW ef_search + candidate pools; lock down maintenance RPC grants & search_path [B0-278/282/283] ([abeeb80](https://github.com/betcocorp/bex2.0/commit/abeeb80f832cd28b8fc118b50b6da564801eaeaf))
* rearranged ingestion ui to make more sense in additional ingestion pages and removed working docs from claude ([fc860f1](https://github.com/betcocorp/bex2.0/commit/fc860f1c94c2431334ad641e690773b1af529ab8))
* **rec-3:** curated cross-reference override — Spartan BNC-15 → Betco Triforce (B0-46/B0-76) ([6d53017](https://github.com/betcocorp/bex2.0/commit/6d53017dee0363d49cd1fde7d13f14de7e95a6c7)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333)
* **rec:** competitive analysis + up to 2 alternatives for a curated recommendation ([6ce90bd](https://github.com/betcocorp/bex2.0/commit/6ce90bd68ee3a74be5ea5e287f7b25ff7753d2b2))
* **rec:** deterministic cross-reference override safety-net (make Triforce land) ([42ca9fe](https://github.com/betcocorp/bex2.0/commit/42ca9fe89f3a130894ed8cb040dae742032b2bbd))
* Recommendations SME agent + competitor cross-reference engine (B0-43/44/47/49/50/51) ([02af888](https://github.com/betcocorp/bex2.0/commit/02af8884d7db21ce8796936f77b9c76d35ec8497)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333)
* **recommendations:** confidence scoring + configurable threshold gate (B0-88) ([fa5b0d1](https://github.com/betcocorp/bex2.0/commit/fa5b0d1a5c95c86556a28b6f2239334c4c6c5e65))
* **recommendations:** cross-reference recommendation prompt template + output schema (B0-90) ([d1a11fa](https://github.com/betcocorp/bex2.0/commit/d1a11fa568637b300b6bf54bf9de5e5f909ba061))
* **recommendations:** guardrails for the web-grounded recommendation (B0-91) ([1f82a40](https://github.com/betcocorp/bex2.0/commit/1f82a40e5c3b447876c3b17b4f44e146b98a2968))
* **recommendations:** LLM competitor-spec enrichment on the heuristic extractor (B0-86) ([9ae36e5](https://github.com/betcocorp/bex2.0/commit/9ae36e576e35d42b702321a49e4af82f3acb1fc3))
* **recommendations:** persist every recommendation (answered + declined) (B0-89) ([87bf45d](https://github.com/betcocorp/bex2.0/commit/87bf45dcb634f37fda82dca7c4e2423c58f196c7))
* **recommendations:** rag cross-reference recommendation tables (B0-82) ([e46f57a](https://github.com/betcocorp/bex2.0/commit/e46f57a0722d3f1a893c0c98271696ac86841be6))
* **recommendations:** recommendation API endpoint + tester UI (B0-94) ([762c1e3](https://github.com/betcocorp/bex2.0/commit/762c1e3baec875928af21c3da9601b31c43b9328))
* **recommendations:** recommendCrossReference() orchestrator, legacy-first + web fallback (B0-85) ([d812f9f](https://github.com/betcocorp/bex2.0/commit/d812f9fedd61cb6e694cf19bdf26ff3f20d01eac))
* **recommendations:** retrieve N Betco candidates from the enriched spec (B0-87) ([09778ce](https://github.com/betcocorp/bex2.0/commit/09778ce9e761d7a76efe52601c50b3749359edd4))
* **recommendations:** web-search cost/domain/rate guardrails (B0-92) ([ebaf14e](https://github.com/betcocorp/bex2.0/commit/ebaf14ebd989b141e57591a49a5b80b8b41be677))
* **recommendations:** wire recommend_cross_reference agent tool into the workflow (B0-93) ([217db0b](https://github.com/betcocorp/bex2.0/commit/217db0b42fe4e60b6587b81bd84ae37ad6afe90f))
* **recommendations:** Zod contracts + repository for cross-reference recommendations (B0-83) ([543958d](https://github.com/betcocorp/bex2.0/commit/543958df135300873d2d722826b704a2ea0468b4))
* reconciling new data from 1.0 ([8203229](https://github.com/betcocorp/bex2.0/commit/8203229d5a37677a6cc1352751524554847024f9))
* restructuring chunks for embedding ([9d847d9](https://github.com/betcocorp/bex2.0/commit/9d847d9967dbc260b66e443026422d0f2c0c4b6b))
* **retrieval:** fetch structured product facts + attach to query result (B0-195) ([07bfa7c](https://github.com/betcocorp/bex2.0/commit/07bfa7c645a78d8932b1005c43fc7ed72bf5cd1b))
* **retrieval:** intent-driven curation knobs (B0-201) ([d7c5493](https://github.com/betcocorp/bex2.0/commit/d7c5493937e409fc7c17a5a167384b6f8aa34c28))
* **retrieval:** near-duplicate suppression across sources [B0-257] ([9fa2cfc](https://github.com/betcocorp/bex2.0/commit/9fa2cfc1fc8c974ba65fd224a1df375352c6c158))
* **retrieval:** product alias table resolution (B0-200) ([b3a7b7f](https://github.com/betcocorp/bex2.0/commit/b3a7b7f8041cbdfe85f401820a7ea7dd90bc1112))
* **retrieval:** surface knowledge chunks in curated results (B0-191) ([e162eb0](https://github.com/betcocorp/bex2.0/commit/e162eb0754c671a78087657003cd9d839cbe2e5e))
* **sds:** scope SDS corpus discovery to policy + content-based language check [B0-243] ([83b3636](https://github.com/betcocorp/bex2.0/commit/83b36368b78d12edcdafa6a6581ecf7716ba30af))
* starting api security work ([ab270e4](https://github.com/betcocorp/bex2.0/commit/ab270e4089c875bba5c0be854e95bf83a59b7a9a))
* test runner suite ([fb517d5](https://github.com/betcocorp/bex2.0/commit/fb517d5b2d6b60b3e1bc631487686bcd9b997fb9))
* **tools:** get_efficacy_data fact-only tool + route dilution/kill-claim intents (B0-197) ([894e33b](https://github.com/betcocorp/bex2.0/commit/894e33b0d1f4f005992cf74374f32b439bba5693))
* **tools:** ground answers on structured facts (B0-196) ([3e3a9a3](https://github.com/betcocorp/bex2.0/commit/3e3a9a31ce930403c8f8c67537b729d7ae97f315))
* tuning the search to optimize both for product data and sds ([6c5d4b5](https://github.com/betcocorp/bex2.0/commit/6c5d4b52678fca96f47f4e9d679e961df0d2d51b))
* tweaking workflows and updating ui responses ([da92099](https://github.com/betcocorp/bex2.0/commit/da92099391273810cbf7d1d4cbed0ffffff9f646))
* ui feature enhancements, new tool product cross reference tool ([f79705f](https://github.com/betcocorp/bex2.0/commit/f79705f87c3e628abd1ce93f2b0332582140c0dc))
* updating code based on docs and specifications already developed ([5b5dcda](https://github.com/betcocorp/bex2.0/commit/5b5dcdae1e04e47a073bf765b16aa81d0ccb29bc))
* updating data, add prompt, remove ([4af379d](https://github.com/betcocorp/bex2.0/commit/4af379db6c8b7f79912e9f00c3de62bb1f495339))
* vercel migration minor ui changes ([e35820a](https://github.com/betcocorp/bex2.0/commit/e35820ad0a6b6bd844bfa17d70644459495af21e))
* web search caching + competitor-spec extraction (B0-55, B0-54) ([28d582b](https://github.com/betcocorp/bex2.0/commit/28d582b2bb4b5bcafa0058573ec5e05eecdad73e))
* web search capability + admin test harness (B0-70) ([485c3d0](https://github.com/betcocorp/bex2.0/commit/485c3d00c4be7e81ee4cc0da45f623d88e0e69ad))
* **websearch:** durable DB-backed response cache (memory -> DB -> provider) ([1a0770b](https://github.com/betcocorp/bex2.0/commit/1a0770b5c15950817897e517fcfa93608ea8d0d6))
* **websearch:** external citation surface in agent output (WEB-6) ([8b80ad3](https://github.com/betcocorp/bex2.0/commit/8b80ad3ac8e190705b01067dae5ef398db90ae12))
* **websearch:** source-trust policy (WEB-2) + guardrails/cost controls (WEB-5) ([7b64c95](https://github.com/betcocorp/bex2.0/commit/7b64c95ce2783bd4162b0d69f0e1d50d82b163cf))
* working on data migration and initial vector embeddings ([59db37e](https://github.com/betcocorp/bex2.0/commit/59db37eed541b4bc06688e8b36a3b95ec21af2b2))
* working on first implementation of sub agents ([5c2fb3d](https://github.com/betcocorp/bex2.0/commit/5c2fb3db56f75587945355439982617149cf0300))

# 1.0.0 (2026-08-16)


### Bug Fixes

* **api-security:** require NextAuth session on /api/admin/tests/* routes ([52734d0](https://github.com/betcocorp/bex2.0/commit/52734d005712406a008c635e63d509dd58a67870))
* **b0-13:** surface chunk ids for retrieval auditing; investigate missed virus claims ([79d90d4](https://github.com/betcocorp/bex2.0/commit/79d90d490f2984406da60039fe23b344b6cb85b5))
* **b0-244:** undefined `KnowledgeChunk` type → `MarkdownChunk` ([27f60b2](https://github.com/betcocorp/bex2.0/commit/27f60b2cadf239d56301adb5eb55830e93cfffb7))
* **b0-272:** prose fallback for efficacy questions + tokenized product-name resolver ([534a9ad](https://github.com/betcocorp/bex2.0/commit/534a9ad59b53dc5b719875fc21939564da49b863))
* **b0-272:** stop hard-filtering scope:'all' retrieval by inferred section_type ([1716acb](https://github.com/betcocorp/bex2.0/commit/1716acb1dd3c853b4a3ce24a9524494907900330))
* **b0-284-hotfix:** restore chunk_sds_document_text TABLE signature ([b0926d6](https://github.com/betcocorp/bex2.0/commit/b0926d6d56f841692ff6d46c2a082d501b013f28))
* **B0-462:** pin pnpm 11 for the release workflow ([bd61dd9](https://github.com/betcocorp/bex2.0/commit/bd61dd96b4b1f00e116f19dde8c6d505aef72d76))
* **database:** add RLS policies to security-less tables & document view security [B0-284, B0-285] ([cb2d432](https://github.com/betcocorp/bex2.0/commit/cb2d432e9997e9a411393f5ef0aa62002ab71c27))
* **efficacy:** make structured efficacy answers work end-to-end ([3425a92](https://github.com/betcocorp/bex2.0/commit/3425a9243fc4ea105c4d703d7d3cf6433009ed32))
* for duplicate key ([748681b](https://github.com/betcocorp/bex2.0/commit/748681b6e2cdda5c523adf9b5c84a3dc80a20249))
* keep the service-token path open on /api/bex/workflow-runs/[id] ([1565177](https://github.com/betcocorp/bex2.0/commit/1565177a3134469d9e044a483524417d4b945c1b))
* **knowledge:** fall back to generic AWS read keys for retool-360 (B0-187) ([080f893](https://github.com/betcocorp/bex2.0/commit/080f89333beb18e1116562c10894abec81a38d33))
* **knowledge:** report ingested status from real chunk counts (B0-188) ([0988352](https://github.com/betcocorp/bex2.0/commit/098835212543c8b434580a02b446d7b8da2a0d6d))
* **migrations:** drop all function overloads before recreate [B0-284] ([e0768a9](https://github.com/betcocorp/bex2.0/commit/e0768a98e5474514704d6bb81dd44536c31adf9f))
* **migrations:** wrap bare RAISE in DO block [B0-284] ([dffc690](https://github.com/betcocorp/bex2.0/commit/dffc690d05164a37187a501d5865159bbfabd08f))
* **na:** let BEX_DISABLE_CONFIDENCE_GATING also bypass regulated-claim grounding and chemistry-mismatch ([d35b0bb](https://github.com/betcocorp/bex2.0/commit/d35b0bb5e9486f1c555ba5f8bc4071469c0228ad))
* **na:** remove duplicate PERMISSIONS keys causing TS1117 and permission-check breakage ([629b54f](https://github.com/betcocorp/bex2.0/commit/629b54f1611a3583b4114a562b26476a703e5bdc))
* **rag:** add filter_product_key to match_corpus_chunks(_hybrid) [B0-250 correction] ([3478014](https://github.com/betcocorp/bex2.0/commit/3478014d2258af8ea3afd7cb4f0f12a9d832cb6d))
* **rag:** correct overload drops for match_product_chunks functions [B0-281] ([a6c688e](https://github.com/betcocorp/bex2.0/commit/a6c688e3fefa299f9b0f52d4d1aa376ffddb482b))
* **rag:** disambiguate dilution_code='0' sentinel into RTU vs missing [B0-265] ([72a5e2d](https://github.com/betcocorp/bex2.0/commit/72a5e2dc1d1eb34746f8f06e14257c55ac3c1569))
* **rag:** disambiguate match_product_chunks_hybrid overload (42725) ([00ef5e6](https://github.com/betcocorp/bex2.0/commit/00ef5e685358f0bbaa068a7c957973d7cacc3260))
* **rag:** drop match_product_chunks overloads before audit [B0-281] ([8fab804](https://github.com/betcocorp/bex2.0/commit/8fab8041b583f69d94281d877ffbf5e54fea5937))
* **rag:** raise statement_timeout on hybrid match RPCs (B0-217) ([df0f156](https://github.com/betcocorp/bex2.0/commit/df0f15654582f74975137dd5fa6bcb563c44c2d3))
* **rag:** stop empty heading-only knowledge chunks from being embedded ([7059665](https://github.com/betcocorp/bex2.0/commit/70596659414360ad7dd410aabc8afa5a461cc3fb))
* **rec:** don't let a validator-revision refusal overwrite a good answer ([fbf644d](https://github.com/betcocorp/bex2.0/commit/fbf644de79c99cdbeeaac989afe84453049b753c))
* **rec:** ground competitor by chemistry + search by capability on cross-ref miss ([659ec92](https://github.com/betcocorp/bex2.0/commit/659ec929d8d49ed8998c36b37edbe5adcb5fb519)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333) [#1](https://github.com/betcocorp/bex2.0/issues/1)
* **rec:** stop forcing the validator on the recommendations route (it was nuking answers) ([f4a6d3e](https://github.com/betcocorp/bex2.0/commit/f4a6d3e367789713581d64ba3597aa02f753b234))
* **rec:** stop stapling a comparable-product headline onto a decline; force validator on rec route ([475d062](https://github.com/betcocorp/bex2.0/commit/475d0623f52d6b52551816a71537860e526fcaa3))
* **rec:** validator must not reject/overwrite a cross-reference recommendation ([3b6c197](https://github.com/betcocorp/bex2.0/commit/3b6c197f5a98358d604543d8fa45e25802d49f3d))
* **tests,rag:** grader decline detection, per-run model, hybrid + knowledge/label scopes ([5c44d6e](https://github.com/betcocorp/bex2.0/commit/5c44d6e07b8366bf1ab9863c1c0c5f793ba8cde2))
* un-ignore src/supabase so new migrations are actually tracked ([8d97504](https://github.com/betcocorp/bex2.0/commit/8d97504f7461b26a105debbd642f00bef957ffb2))


### Features

* add initial app code ([9d5bfa1](https://github.com/betcocorp/bex2.0/commit/9d5bfa1c303462d9face65303fc5029607f08ecf))
* added api test for calling web search tool using new token system ([a5fde6c](https://github.com/betcocorp/bex2.0/commit/a5fde6c946200c1b46fdb09f2757ad434b23a4f9))
* added mew chart ([4718a85](https://github.com/betcocorp/bex2.0/commit/4718a850befbd77c7e05d55595b053f5041c82b1))
* added more shadcn components ([ba27c26](https://github.com/betcocorp/bex2.0/commit/ba27c26b43620ecf8498495490750aca939c0273))
* adding auth ([45e1e5d](https://github.com/betcocorp/bex2.0/commit/45e1e5d466d71ce070fbe4836929ceed416c5ded))
* adding failed queue ([4b627f6](https://github.com/betcocorp/bex2.0/commit/4b627f6a6c0913bf082ca5b2151a87da647931f9))
* adding initial routing and orchestration ([766ae4c](https://github.com/betcocorp/bex2.0/commit/766ae4cde2f9d90a6668f31a52c9c6864287d3fb))
* adding more code to customize logic and functionality ([fa96e4c](https://github.com/betcocorp/bex2.0/commit/fa96e4c9aa8961dcbf1d738e2272340a78809b9f))
* adding more reporting and observability to the search ([29d7374](https://github.com/betcocorp/bex2.0/commit/29d7374fdf8dc6bb47f2c3d70c6d2cbad7a4af16))
* adding more reporting fine tuning. Adding other funcctionality to support workflow along with additional reporting ([b5b24fe](https://github.com/betcocorp/bex2.0/commit/b5b24fe944f92c331416d83931af346b3a07dbd7))
* adding more ui and refining views further ([2fff2b5](https://github.com/betcocorp/bex2.0/commit/2fff2b5779b6866d1ee39ff6a07b5678fb345552))
* adding sentry ([e2a0030](https://github.com/betcocorp/bex2.0/commit/e2a00309f2eeecf52e96efcd773afd7a9ef58b63))
* adding variable similarity threshold to search ([8a15332](https://github.com/betcocorp/bex2.0/commit/8a1533206649ffab7b6c035033fc9a214d95026a))
* **admin:** add Web search card to the /admin/tools landing page ([421361e](https://github.com/betcocorp/bex2.0/commit/421361e86ecdf18660210d366d4495f56427a8d4))
* **admin:** cached web-search results table in /admin/tools/web-search (B0-109) ([adb321d](https://github.com/betcocorp/bex2.0/commit/adb321d92d66d9881abece931e6494834e2f297a))
* **admin:** Orphan Monitor + product-line backfill migration [B0-267] ([d7b193d](https://github.com/betcocorp/bex2.0/commit/d7b193d5eb176fce0a2c78bcb1dfa4989975af92))
* **admin:** show web-search cache duration in Cached results subtext ([9b3f8e7](https://github.com/betcocorp/bex2.0/commit/9b3f8e7e5833d547474147ca2f03ea74f3a62636))
* **api-security:** admin projects list + create wizard (B0-116) ([4aff4d2](https://github.com/betcocorp/bex2.0/commit/4aff4d2c784df6404a2503a56ced6237e10a782e))
* **api-security:** API analytics dashboard (B0-120) ([7a88b13](https://github.com/betcocorp/bex2.0/commit/7a88b137aefb5f3200bdfb3aaffaa86b95b5aee4))
* **api-security:** app detail — tokens, rotation, kill switch, rate limit (B0-118) ([6227e1b](https://github.com/betcocorp/bex2.0/commit/6227e1bfd053c9965d5d58c903540308b71ab575))
* **api-security:** enforce per-client token on all /api/v1/* + delete legacy auth (B0-115) ([48cdf14](https://github.com/betcocorp/bex2.0/commit/48cdf14e78fca6553f8f6a7b0b347e5ed53af651))
* **api-security:** per-app rate limiting (429 + Retry-After) (B0-119) ([31fe4c3](https://github.com/betcocorp/bex2.0/commit/31fe4c386f25b1dc11bd5641c3ea45ff8a5fd08b))
* **api-security:** per-request logging + last-used tracking for /api/v1/* (B0-117) ([4e1d942](https://github.com/betcocorp/bex2.0/commit/4e1d942e0c3a80af868ede76edecf1e100a58762))
* **api-security:** project detail — apps, add app, kill switch (B0-130) ([9893c31](https://github.com/betcocorp/bex2.0/commit/9893c31be3095527d748f38af35db2671920ebd8))
* **api-security:** require NextAuth session on all /api/bex/* routes (B0-114) ([c1692d4](https://github.com/betcocorp/bex2.0/commit/c1692d4b4a61c6d141306918c846e59efe3ecc84))
* **api-security:** thread LLM token usage into request log (B0-117) ([5d1fb29](https://github.com/betcocorp/bex2.0/commit/5d1fb293220d2dc41a860b6f6f253d77bc7fa1ac))
* **api:** add /api/v1/tools registry + wire web-search into withApiV1 [B0-241/B0-242] ([73a8236](https://github.com/betcocorp/bex2.0/commit/73a8236db24b93bb25441a8605f219da6de0be26))
* **api:** expose web search as a client-authenticated v1 tool ([789df5c](https://github.com/betcocorp/bex2.0/commit/789df5c5461503a9cace9c9802b7be382407b6b7))
* B0-183 deterministic web-search fallback on cross-reference miss ([ee4b879](https://github.com/betcocorp/bex2.0/commit/ee4b879dd964dbc528b94f05792b76dc65de17fe))
* **B0-318,B0-319,B0-320,B0-321:** capture and chart time-to-first-token for test runs ([c3bfb16](https://github.com/betcocorp/bex2.0/commit/c3bfb16f17591d3ffaf1dbe00c3e629ef6a01489))
* **B0-349:** persist pre-validator draft answer on every workflow run ([d7f557e](https://github.com/betcocorp/bex2.0/commit/d7f557e38967a8e9828f0c1f5a34aded3b62959f))
* **B0-398:** add prompt-version chips to run header, runs list, and item rows ([7f7e47e](https://github.com/betcocorp/bex2.0/commit/7f7e47e139198fc8f63cfead2e609f04a333fbbf))
* **B0-399:** distinguish four run-trace empty states, centralize search-run extractors ([210f1e5](https://github.com/betcocorp/bex2.0/commit/210f1e531479b718c7435d4edfc0a3638cebb3ce))
* B0-448 conversation source column, bex.chat.view-all, test-run backfill ([932b4bd](https://github.com/betcocorp/bex2.0/commit/932b4bd8294ce062b7d884a1ecec871dbebeb8b6))
* **B0-462:** add semantic-release versioning CI for main/staging/dev ([38841f0](https://github.com/betcocorp/bex2.0/commit/38841f09bf234bbca838b8760726a476f353f045))
* **B0-462:** permissions and minor styling ([80f715f](https://github.com/betcocorp/bex2.0/commit/80f715f0791504867ff48d72a8dd34631188f586))
* **b0-95:** recommendation review & verification queue admin UI ([5c9bdd8](https://github.com/betcocorp/bex2.0/commit/5c9bdd8d580e926177af57e37887c8f2de3af235))
* **b0-96:** promote verified recommendations into fast-path xref + metrics ([4717094](https://github.com/betcocorp/bex2.0/commit/4717094a75acc2500f4e1045fc884bae4f35fa18))
* **b0-97:** threshold calibration tooling + document the real ground-truth gap ([b7eacfc](https://github.com/betcocorp/bex2.0/commit/b7eacfc1d5aaf7428828be46c8fc4c68c6d252c1))
* BO-114 ([e602c21](https://github.com/betcocorp/bex2.0/commit/e602c215f482e3b9e9fd9dd26df3c5be9346c340))
* **BO-304:** Efficacy ingestion ui reworked the ui to make more sense ([2ad40ea](https://github.com/betcocorp/bex2.0/commit/2ad40ead07423706ab800725abb9d890a7d395ab))
* BO-99 ([49c93c0](https://github.com/betcocorp/bex2.0/commit/49c93c07600db5cce3f2e3fd72a02ba0eb336598))
* **category:** admin curation UI for product→category links (B0-36) ([181e08a](https://github.com/betcocorp/bex2.0/commit/181e08a244bd6bcb1369ce4f4f08dfc58892b7b4))
* **category:** authoritative product↔category linker from betco.com scrape (B0-34) ([ba2f7fa](https://github.com/betcocorp/bex2.0/commit/ba2f7fa7dd0e961cae7e9abf4051241df633c886))
* **category:** category resolver — query -> taxonomy node + confidence (B0-27) ([809f107](https://github.com/betcocorp/bex2.0/commit/809f10763f3e1a0accb0c584e3a45043f62cc227))
* **category:** category-first router + agent tool + routing telemetry (B0-29/B0-30/B0-31) ([8c80b37](https://github.com/betcocorp/bex2.0/commit/8c80b37f22a151bec264543bc0121acc9d85ac12))
* **category:** continuous delta sync of product→category links (B0-37) ([40837d9](https://github.com/betcocorp/bex2.0/commit/40837d911642e6cd817da1b0c400f2b0964654e9))
* **category:** cross-validation report vs legacy + live site (B0-38) ([8ee2e98](https://github.com/betcocorp/bex2.0/commit/8ee2e989811b56c38b8ecf30f577a653a9e14acb))
* **category:** DB-backed taxonomy retrieval — query -> node -> products (B0-28, B0-33/B0-34 wiring) ([d1b753a](https://github.com/betcocorp/bex2.0/commit/d1b753aafc16b2d6a13675f7bd0f06f265cf4fd8))
* **category:** LLM classifier for unlinked/low-confidence prod-lines (B0-35) ([5621f68](https://github.com/betcocorp/bex2.0/commit/5621f68aca5f7233d8a51d6616bb64c87d18ce49))
* **category:** seed exact betco.com taxonomy + segregate by source (B0-33) ([9ea119d](https://github.com/betcocorp/bex2.0/commit/9ea119dc38a80ba850559a243255355404413163))
* chore cleaning up code ([bfdc4b1](https://github.com/betcocorp/bex2.0/commit/bfdc4b1e4cac10e167d1d082df161b0b16126e83))
* cleaning up ui ([856ba40](https://github.com/betcocorp/bex2.0/commit/856ba40b39c36d2260b2a7346e87eccf635e767b))
* consolidated some ui, abstracted utilities, abstracted agent definition for sanity ([1c3071e](https://github.com/betcocorp/bex2.0/commit/1c3071e67409096b701ebdc562600c23f9557b1c))
* consolidated the two cross reference pages into one with tabs ([9e53980](https://github.com/betcocorp/bex2.0/commit/9e5398069f1daef61ca5125f0e73d38b25a39f0a))
* continuing to refine context and document corpus structuring ([eee4555](https://github.com/betcocorp/bex2.0/commit/eee45559b013b851ccb23baab81d6e15b0e70eed))
* converted all code to utilize 3072 embedding over 1536 ([ea3cf11](https://github.com/betcocorp/bex2.0/commit/ea3cf11998077d3b5cc233e8ed445516f53758c7))
* converting embeddings to use 3000+ dimensions ([afc7dd2](https://github.com/betcocorp/bex2.0/commit/afc7dd2274e3f5885ef41236f5b009127aa26afa))
* download timeline json, fix corpus inex, minor ui changes ([4f180bd](https://github.com/betcocorp/bex2.0/commit/4f180bda71d8c23b22ce1d74c3a85978b8fb1803))
* **efficacy/labels:** generalize ingestion pipeline, add chunking RPC, schema, retrieval enhancements [B0-227-238, B0-256-283] ([47ab061](https://github.com/betcocorp/bex2.0/commit/47ab0619d45df00c8f2b057048ae2f1f4154c645))
* **efficacy/tools:** implement deterministic dilution lookup with RAG database integration [B0-288] ([67d23b5](https://github.com/betcocorp/bex2.0/commit/67d23b5e83c17986ac0dc3146feb3e05d87f35f7))
* **efficacy:** cross-check and enrich the 70 converted markdown files [B0-224] ([9e40736](https://github.com/betcocorp/bex2.0/commit/9e40736c56389f996aae43921e574f86a4309d53))
* **efficacy:** new document_kind='efficacy' RAG pipeline, crosswalk, citation [B0-227..238] ([3473f11](https://github.com/betcocorp/bex2.0/commit/3473f1174cf02568073e0bd1c378aa6756a6e12b))
* **efficacy:** parse Master Efficacy Version Data into a structured table [B0-223] ([2cd8db9](https://github.com/betcocorp/bex2.0/commit/2cd8db9b4ab741e6c24c545f26e5b5ea7ad428e3))
* enhanced query tuning ([0bb87ca](https://github.com/betcocorp/bex2.0/commit/0bb87cad0560a96c14215866152d6bf06a558c4b))
* enriching data and updating RAG system ([59f118f](https://github.com/betcocorp/bex2.0/commit/59f118f15761626b479a5a8f0c9cda3c89dbe244))
* expand eval refusal detection and add product category tools ([c6724f8](https://github.com/betcocorp/bex2.0/commit/c6724f80772ac7ab8143d0e28ca9f919172f3686))
* expanding the rag search results to be include more inclusive data rather than being fragmented ([53b5050](https://github.com/betcocorp/bex2.0/commit/53b50501d708e16dbf4b5b2f2916bcda9756c361))
* ingesting more efficacy docs, fixing bugs from migration and resolving new efficacy mappings ([2178dd9](https://github.com/betcocorp/bex2.0/commit/2178dd9146f4c709f511202bfdf11ad0f8c5c5ff))
* ingestion of label data ([36a73e4](https://github.com/betcocorp/bex2.0/commit/36a73e443778b49984791ad3aeb9d381eee4602a))
* knowledge base ([0012449](https://github.com/betcocorp/bex2.0/commit/0012449ac739d93e366fc89661517b69e07fc438))
* **knowledge:** admin ingest panel for v1 markdown corpus (B0-187/188/189/190) ([4509adb](https://github.com/betcocorp/bex2.0/commit/4509adb56a9033658bc69741c476c0260dfdff79))
* **knowledge:** markdown-ingest foundation — S3 read, discovery, chunker ([4ffc172](https://github.com/betcocorp/bex2.0/commit/4ffc1722800ad55cfc21eb0af54481b1aac101a4))
* **labels:** validator guardrails, exact lookup tool, citations, discontinued filter [B0-257] ([25a1559](https://github.com/betcocorp/bex2.0/commit/25a155998bc0d7277abebad52743dbb9da704d96))
* migrating the remaining items to vercel ([634e9d3](https://github.com/betcocorp/bex2.0/commit/634e9d33777b88181ee06357e74e5ad661fa29df))
* migration and pipeline remapping ([e283757](https://github.com/betcocorp/bex2.0/commit/e2837578dd80ca7331cc15066a559b7c1feef455))
* minor updates for test runner ui additions ([778c175](https://github.com/betcocorp/bex2.0/commit/778c175d0041256ff74177360fdf043401f667ff))
* **orphans:** view full underlying record from the orphan queue ([d819c0e](https://github.com/betcocorp/bex2.0/commit/d819c0ec62234271c7e5efa244abc676c30e6b0e))
* performance enhancements ([7b5e06d](https://github.com/betcocorp/bex2.0/commit/7b5e06d8bcd345cab0bf105fac0e7c4b0787bbb0))
* persist anlysis of runs to db ([49c3e94](https://github.com/betcocorp/bex2.0/commit/49c3e9412c09a3e43e69c585f2dcd4f9a9498467))
* **rag/products/efficacy:** complete B0-279/281/284/286/287/289 work ([f8c67ef](https://github.com/betcocorp/bex2.0/commit/f8c67ef27a2545b6afa5fce8e2e57bc44c4aa7b2))
* **rag:** activate filter_product_key in retrieval query resolver [B0-250] ([b857e9b](https://github.com/betcocorp/bex2.0/commit/b857e9b9d2294f9a43f328fcbb0b660cff5334b6))
* **rag:** backfill active products into rag.entity as product-tier entities [B0-246] ([572ab24](https://github.com/betcocorp/bex2.0/commit/572ab244966b7b2dd90e47fb77087ae95beecefd))
* **rag:** classify product_application from category taxonomy [B0-263] ([e6735e5](https://github.com/betcocorp/bex2.0/commit/e6735e5b9e8037b8199603f826ce5b308dc9df7e))
* **rag:** enable cross-encoder reranking on product-support retrieval path [B0-280] ([8a09582](https://github.com/betcocorp/bex2.0/commit/8a095821e01a22b51f983ca26cedb67c7f2f9a72))
* **rag:** extract dilution values from directions text for 34 lines [B0-264] ([6da953e](https://github.com/betcocorp/bex2.0/commit/6da953e3ccb6c0d881c72ddcc5fe4cbd7726f4d8))
* **rag:** link active product entities to their product-line parents [B0-247] ([717c698](https://github.com/betcocorp/bex2.0/commit/717c69864a90f61ed656dae40f5b15d4bf909736))
* **rag:** link unambiguous label documents to active product entities [B0-249] ([bc809d1](https://github.com/betcocorp/bex2.0/commit/bc809d135ceee3ae71bb1a56bab87a9d0e05a848))
* **rag:** seed SKU/InvtID aliases for active products [B0-248] ([95fb31c](https://github.com/betcocorp/bex2.0/commit/95fb31c8ac61450c7a3b54ed4ac9097819b6e6bc))
* **rag:** tune HNSW ef_search + candidate pools; lock down maintenance RPC grants & search_path [B0-278/282/283] ([abeeb80](https://github.com/betcocorp/bex2.0/commit/abeeb80f832cd28b8fc118b50b6da564801eaeaf))
* rearranged ingestion ui to make more sense in additional ingestion pages and removed working docs from claude ([fc860f1](https://github.com/betcocorp/bex2.0/commit/fc860f1c94c2431334ad641e690773b1af529ab8))
* **rec-3:** curated cross-reference override — Spartan BNC-15 → Betco Triforce (B0-46/B0-76) ([6d53017](https://github.com/betcocorp/bex2.0/commit/6d53017dee0363d49cd1fde7d13f14de7e95a6c7)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333)
* **rec:** competitive analysis + up to 2 alternatives for a curated recommendation ([6ce90bd](https://github.com/betcocorp/bex2.0/commit/6ce90bd68ee3a74be5ea5e287f7b25ff7753d2b2))
* **rec:** deterministic cross-reference override safety-net (make Triforce land) ([42ca9fe](https://github.com/betcocorp/bex2.0/commit/42ca9fe89f3a130894ed8cb040dae742032b2bbd))
* Recommendations SME agent + competitor cross-reference engine (B0-43/44/47/49/50/51) ([02af888](https://github.com/betcocorp/bex2.0/commit/02af8884d7db21ce8796936f77b9c76d35ec8497)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333)
* **recommendations:** confidence scoring + configurable threshold gate (B0-88) ([fa5b0d1](https://github.com/betcocorp/bex2.0/commit/fa5b0d1a5c95c86556a28b6f2239334c4c6c5e65))
* **recommendations:** cross-reference recommendation prompt template + output schema (B0-90) ([d1a11fa](https://github.com/betcocorp/bex2.0/commit/d1a11fa568637b300b6bf54bf9de5e5f909ba061))
* **recommendations:** guardrails for the web-grounded recommendation (B0-91) ([1f82a40](https://github.com/betcocorp/bex2.0/commit/1f82a40e5c3b447876c3b17b4f44e146b98a2968))
* **recommendations:** LLM competitor-spec enrichment on the heuristic extractor (B0-86) ([9ae36e5](https://github.com/betcocorp/bex2.0/commit/9ae36e576e35d42b702321a49e4af82f3acb1fc3))
* **recommendations:** persist every recommendation (answered + declined) (B0-89) ([87bf45d](https://github.com/betcocorp/bex2.0/commit/87bf45dcb634f37fda82dca7c4e2423c58f196c7))
* **recommendations:** rag cross-reference recommendation tables (B0-82) ([e46f57a](https://github.com/betcocorp/bex2.0/commit/e46f57a0722d3f1a893c0c98271696ac86841be6))
* **recommendations:** recommendation API endpoint + tester UI (B0-94) ([762c1e3](https://github.com/betcocorp/bex2.0/commit/762c1e3baec875928af21c3da9601b31c43b9328))
* **recommendations:** recommendCrossReference() orchestrator, legacy-first + web fallback (B0-85) ([d812f9f](https://github.com/betcocorp/bex2.0/commit/d812f9fedd61cb6e694cf19bdf26ff3f20d01eac))
* **recommendations:** retrieve N Betco candidates from the enriched spec (B0-87) ([09778ce](https://github.com/betcocorp/bex2.0/commit/09778ce9e761d7a76efe52601c50b3749359edd4))
* **recommendations:** web-search cost/domain/rate guardrails (B0-92) ([ebaf14e](https://github.com/betcocorp/bex2.0/commit/ebaf14ebd989b141e57591a49a5b80b8b41be677))
* **recommendations:** wire recommend_cross_reference agent tool into the workflow (B0-93) ([217db0b](https://github.com/betcocorp/bex2.0/commit/217db0b42fe4e60b6587b81bd84ae37ad6afe90f))
* **recommendations:** Zod contracts + repository for cross-reference recommendations (B0-83) ([543958d](https://github.com/betcocorp/bex2.0/commit/543958df135300873d2d722826b704a2ea0468b4))
* reconciling new data from 1.0 ([8203229](https://github.com/betcocorp/bex2.0/commit/8203229d5a37677a6cc1352751524554847024f9))
* restructuring chunks for embedding ([9d847d9](https://github.com/betcocorp/bex2.0/commit/9d847d9967dbc260b66e443026422d0f2c0c4b6b))
* **retrieval:** fetch structured product facts + attach to query result (B0-195) ([07bfa7c](https://github.com/betcocorp/bex2.0/commit/07bfa7c645a78d8932b1005c43fc7ed72bf5cd1b))
* **retrieval:** intent-driven curation knobs (B0-201) ([d7c5493](https://github.com/betcocorp/bex2.0/commit/d7c5493937e409fc7c17a5a167384b6f8aa34c28))
* **retrieval:** near-duplicate suppression across sources [B0-257] ([9fa2cfc](https://github.com/betcocorp/bex2.0/commit/9fa2cfc1fc8c974ba65fd224a1df375352c6c158))
* **retrieval:** product alias table resolution (B0-200) ([b3a7b7f](https://github.com/betcocorp/bex2.0/commit/b3a7b7f8041cbdfe85f401820a7ea7dd90bc1112))
* **retrieval:** surface knowledge chunks in curated results (B0-191) ([e162eb0](https://github.com/betcocorp/bex2.0/commit/e162eb0754c671a78087657003cd9d839cbe2e5e))
* **sds:** scope SDS corpus discovery to policy + content-based language check [B0-243] ([83b3636](https://github.com/betcocorp/bex2.0/commit/83b36368b78d12edcdafa6a6581ecf7716ba30af))
* starting api security work ([ab270e4](https://github.com/betcocorp/bex2.0/commit/ab270e4089c875bba5c0be854e95bf83a59b7a9a))
* test runner suite ([fb517d5](https://github.com/betcocorp/bex2.0/commit/fb517d5b2d6b60b3e1bc631487686bcd9b997fb9))
* **tools:** get_efficacy_data fact-only tool + route dilution/kill-claim intents (B0-197) ([894e33b](https://github.com/betcocorp/bex2.0/commit/894e33b0d1f4f005992cf74374f32b439bba5693))
* **tools:** ground answers on structured facts (B0-196) ([3e3a9a3](https://github.com/betcocorp/bex2.0/commit/3e3a9a31ce930403c8f8c67537b729d7ae97f315))
* tuning the search to optimize both for product data and sds ([6c5d4b5](https://github.com/betcocorp/bex2.0/commit/6c5d4b52678fca96f47f4e9d679e961df0d2d51b))
* tweaking workflows and updating ui responses ([da92099](https://github.com/betcocorp/bex2.0/commit/da92099391273810cbf7d1d4cbed0ffffff9f646))
* ui feature enhancements, new tool product cross reference tool ([f79705f](https://github.com/betcocorp/bex2.0/commit/f79705f87c3e628abd1ce93f2b0332582140c0dc))
* updating code based on docs and specifications already developed ([5b5dcda](https://github.com/betcocorp/bex2.0/commit/5b5dcdae1e04e47a073bf765b16aa81d0ccb29bc))
* updating data, add prompt, remove ([4af379d](https://github.com/betcocorp/bex2.0/commit/4af379db6c8b7f79912e9f00c3de62bb1f495339))
* vercel migration minor ui changes ([e35820a](https://github.com/betcocorp/bex2.0/commit/e35820ad0a6b6bd844bfa17d70644459495af21e))
* web search caching + competitor-spec extraction (B0-55, B0-54) ([28d582b](https://github.com/betcocorp/bex2.0/commit/28d582b2bb4b5bcafa0058573ec5e05eecdad73e))
* web search capability + admin test harness (B0-70) ([485c3d0](https://github.com/betcocorp/bex2.0/commit/485c3d00c4be7e81ee4cc0da45f623d88e0e69ad))
* **websearch:** durable DB-backed response cache (memory -> DB -> provider) ([1a0770b](https://github.com/betcocorp/bex2.0/commit/1a0770b5c15950817897e517fcfa93608ea8d0d6))
* **websearch:** external citation surface in agent output (WEB-6) ([8b80ad3](https://github.com/betcocorp/bex2.0/commit/8b80ad3ac8e190705b01067dae5ef398db90ae12))
* **websearch:** source-trust policy (WEB-2) + guardrails/cost controls (WEB-5) ([7b64c95](https://github.com/betcocorp/bex2.0/commit/7b64c95ce2783bd4162b0d69f0e1d50d82b163cf))
* working on data migration and initial vector embeddings ([59db37e](https://github.com/betcocorp/bex2.0/commit/59db37eed541b4bc06688e8b36a3b95ec21af2b2))
* working on first implementation of sub agents ([5c2fb3d](https://github.com/betcocorp/bex2.0/commit/5c2fb3db56f75587945355439982617149cf0300))

# 1.0.0 (2026-08-16)


### Bug Fixes

* **api-security:** require NextAuth session on /api/admin/tests/* routes ([52734d0](https://github.com/betcocorp/bex2.0/commit/52734d005712406a008c635e63d509dd58a67870))
* **b0-13:** surface chunk ids for retrieval auditing; investigate missed virus claims ([79d90d4](https://github.com/betcocorp/bex2.0/commit/79d90d490f2984406da60039fe23b344b6cb85b5))
* **b0-244:** undefined `KnowledgeChunk` type → `MarkdownChunk` ([27f60b2](https://github.com/betcocorp/bex2.0/commit/27f60b2cadf239d56301adb5eb55830e93cfffb7))
* **b0-272:** prose fallback for efficacy questions + tokenized product-name resolver ([534a9ad](https://github.com/betcocorp/bex2.0/commit/534a9ad59b53dc5b719875fc21939564da49b863))
* **b0-272:** stop hard-filtering scope:'all' retrieval by inferred section_type ([1716acb](https://github.com/betcocorp/bex2.0/commit/1716acb1dd3c853b4a3ce24a9524494907900330))
* **b0-284-hotfix:** restore chunk_sds_document_text TABLE signature ([b0926d6](https://github.com/betcocorp/bex2.0/commit/b0926d6d56f841692ff6d46c2a082d501b013f28))
* **B0-462:** pin pnpm 11 for the release workflow ([bd61dd9](https://github.com/betcocorp/bex2.0/commit/bd61dd96b4b1f00e116f19dde8c6d505aef72d76))
* **database:** add RLS policies to security-less tables & document view security [B0-284, B0-285] ([cb2d432](https://github.com/betcocorp/bex2.0/commit/cb2d432e9997e9a411393f5ef0aa62002ab71c27))
* **efficacy:** make structured efficacy answers work end-to-end ([3425a92](https://github.com/betcocorp/bex2.0/commit/3425a9243fc4ea105c4d703d7d3cf6433009ed32))
* for duplicate key ([748681b](https://github.com/betcocorp/bex2.0/commit/748681b6e2cdda5c523adf9b5c84a3dc80a20249))
* keep the service-token path open on /api/bex/workflow-runs/[id] ([1565177](https://github.com/betcocorp/bex2.0/commit/1565177a3134469d9e044a483524417d4b945c1b))
* **knowledge:** fall back to generic AWS read keys for retool-360 (B0-187) ([080f893](https://github.com/betcocorp/bex2.0/commit/080f89333beb18e1116562c10894abec81a38d33))
* **knowledge:** report ingested status from real chunk counts (B0-188) ([0988352](https://github.com/betcocorp/bex2.0/commit/098835212543c8b434580a02b446d7b8da2a0d6d))
* **migrations:** drop all function overloads before recreate [B0-284] ([e0768a9](https://github.com/betcocorp/bex2.0/commit/e0768a98e5474514704d6bb81dd44536c31adf9f))
* **migrations:** wrap bare RAISE in DO block [B0-284] ([dffc690](https://github.com/betcocorp/bex2.0/commit/dffc690d05164a37187a501d5865159bbfabd08f))
* **na:** let BEX_DISABLE_CONFIDENCE_GATING also bypass regulated-claim grounding and chemistry-mismatch ([d35b0bb](https://github.com/betcocorp/bex2.0/commit/d35b0bb5e9486f1c555ba5f8bc4071469c0228ad))
* **na:** remove duplicate PERMISSIONS keys causing TS1117 and permission-check breakage ([629b54f](https://github.com/betcocorp/bex2.0/commit/629b54f1611a3583b4114a562b26476a703e5bdc))
* **rag:** add filter_product_key to match_corpus_chunks(_hybrid) [B0-250 correction] ([3478014](https://github.com/betcocorp/bex2.0/commit/3478014d2258af8ea3afd7cb4f0f12a9d832cb6d))
* **rag:** correct overload drops for match_product_chunks functions [B0-281] ([a6c688e](https://github.com/betcocorp/bex2.0/commit/a6c688e3fefa299f9b0f52d4d1aa376ffddb482b))
* **rag:** disambiguate dilution_code='0' sentinel into RTU vs missing [B0-265] ([72a5e2d](https://github.com/betcocorp/bex2.0/commit/72a5e2dc1d1eb34746f8f06e14257c55ac3c1569))
* **rag:** disambiguate match_product_chunks_hybrid overload (42725) ([00ef5e6](https://github.com/betcocorp/bex2.0/commit/00ef5e685358f0bbaa068a7c957973d7cacc3260))
* **rag:** drop match_product_chunks overloads before audit [B0-281] ([8fab804](https://github.com/betcocorp/bex2.0/commit/8fab8041b583f69d94281d877ffbf5e54fea5937))
* **rag:** raise statement_timeout on hybrid match RPCs (B0-217) ([df0f156](https://github.com/betcocorp/bex2.0/commit/df0f15654582f74975137dd5fa6bcb563c44c2d3))
* **rag:** stop empty heading-only knowledge chunks from being embedded ([7059665](https://github.com/betcocorp/bex2.0/commit/70596659414360ad7dd410aabc8afa5a461cc3fb))
* **rec:** don't let a validator-revision refusal overwrite a good answer ([fbf644d](https://github.com/betcocorp/bex2.0/commit/fbf644de79c99cdbeeaac989afe84453049b753c))
* **rec:** ground competitor by chemistry + search by capability on cross-ref miss ([659ec92](https://github.com/betcocorp/bex2.0/commit/659ec929d8d49ed8998c36b37edbe5adcb5fb519)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333) [#1](https://github.com/betcocorp/bex2.0/issues/1)
* **rec:** stop forcing the validator on the recommendations route (it was nuking answers) ([f4a6d3e](https://github.com/betcocorp/bex2.0/commit/f4a6d3e367789713581d64ba3597aa02f753b234))
* **rec:** stop stapling a comparable-product headline onto a decline; force validator on rec route ([475d062](https://github.com/betcocorp/bex2.0/commit/475d0623f52d6b52551816a71537860e526fcaa3))
* **rec:** validator must not reject/overwrite a cross-reference recommendation ([3b6c197](https://github.com/betcocorp/bex2.0/commit/3b6c197f5a98358d604543d8fa45e25802d49f3d))
* **tests,rag:** grader decline detection, per-run model, hybrid + knowledge/label scopes ([5c44d6e](https://github.com/betcocorp/bex2.0/commit/5c44d6e07b8366bf1ab9863c1c0c5f793ba8cde2))
* un-ignore src/supabase so new migrations are actually tracked ([8d97504](https://github.com/betcocorp/bex2.0/commit/8d97504f7461b26a105debbd642f00bef957ffb2))


### Features

* add initial app code ([9d5bfa1](https://github.com/betcocorp/bex2.0/commit/9d5bfa1c303462d9face65303fc5029607f08ecf))
* added api test for calling web search tool using new token system ([a5fde6c](https://github.com/betcocorp/bex2.0/commit/a5fde6c946200c1b46fdb09f2757ad434b23a4f9))
* added mew chart ([4718a85](https://github.com/betcocorp/bex2.0/commit/4718a850befbd77c7e05d55595b053f5041c82b1))
* added more shadcn components ([ba27c26](https://github.com/betcocorp/bex2.0/commit/ba27c26b43620ecf8498495490750aca939c0273))
* adding auth ([45e1e5d](https://github.com/betcocorp/bex2.0/commit/45e1e5d466d71ce070fbe4836929ceed416c5ded))
* adding failed queue ([4b627f6](https://github.com/betcocorp/bex2.0/commit/4b627f6a6c0913bf082ca5b2151a87da647931f9))
* adding initial routing and orchestration ([766ae4c](https://github.com/betcocorp/bex2.0/commit/766ae4cde2f9d90a6668f31a52c9c6864287d3fb))
* adding more code to customize logic and functionality ([fa96e4c](https://github.com/betcocorp/bex2.0/commit/fa96e4c9aa8961dcbf1d738e2272340a78809b9f))
* adding more reporting and observability to the search ([29d7374](https://github.com/betcocorp/bex2.0/commit/29d7374fdf8dc6bb47f2c3d70c6d2cbad7a4af16))
* adding more reporting fine tuning. Adding other funcctionality to support workflow along with additional reporting ([b5b24fe](https://github.com/betcocorp/bex2.0/commit/b5b24fe944f92c331416d83931af346b3a07dbd7))
* adding more ui and refining views further ([2fff2b5](https://github.com/betcocorp/bex2.0/commit/2fff2b5779b6866d1ee39ff6a07b5678fb345552))
* adding sentry ([e2a0030](https://github.com/betcocorp/bex2.0/commit/e2a00309f2eeecf52e96efcd773afd7a9ef58b63))
* adding variable similarity threshold to search ([8a15332](https://github.com/betcocorp/bex2.0/commit/8a1533206649ffab7b6c035033fc9a214d95026a))
* **admin:** add Web search card to the /admin/tools landing page ([421361e](https://github.com/betcocorp/bex2.0/commit/421361e86ecdf18660210d366d4495f56427a8d4))
* **admin:** cached web-search results table in /admin/tools/web-search (B0-109) ([adb321d](https://github.com/betcocorp/bex2.0/commit/adb321d92d66d9881abece931e6494834e2f297a))
* **admin:** Orphan Monitor + product-line backfill migration [B0-267] ([d7b193d](https://github.com/betcocorp/bex2.0/commit/d7b193d5eb176fce0a2c78bcb1dfa4989975af92))
* **admin:** show web-search cache duration in Cached results subtext ([9b3f8e7](https://github.com/betcocorp/bex2.0/commit/9b3f8e7e5833d547474147ca2f03ea74f3a62636))
* **api-security:** admin projects list + create wizard (B0-116) ([4aff4d2](https://github.com/betcocorp/bex2.0/commit/4aff4d2c784df6404a2503a56ced6237e10a782e))
* **api-security:** API analytics dashboard (B0-120) ([7a88b13](https://github.com/betcocorp/bex2.0/commit/7a88b137aefb5f3200bdfb3aaffaa86b95b5aee4))
* **api-security:** app detail — tokens, rotation, kill switch, rate limit (B0-118) ([6227e1b](https://github.com/betcocorp/bex2.0/commit/6227e1bfd053c9965d5d58c903540308b71ab575))
* **api-security:** enforce per-client token on all /api/v1/* + delete legacy auth (B0-115) ([48cdf14](https://github.com/betcocorp/bex2.0/commit/48cdf14e78fca6553f8f6a7b0b347e5ed53af651))
* **api-security:** per-app rate limiting (429 + Retry-After) (B0-119) ([31fe4c3](https://github.com/betcocorp/bex2.0/commit/31fe4c386f25b1dc11bd5641c3ea45ff8a5fd08b))
* **api-security:** per-request logging + last-used tracking for /api/v1/* (B0-117) ([4e1d942](https://github.com/betcocorp/bex2.0/commit/4e1d942e0c3a80af868ede76edecf1e100a58762))
* **api-security:** project detail — apps, add app, kill switch (B0-130) ([9893c31](https://github.com/betcocorp/bex2.0/commit/9893c31be3095527d748f38af35db2671920ebd8))
* **api-security:** require NextAuth session on all /api/bex/* routes (B0-114) ([c1692d4](https://github.com/betcocorp/bex2.0/commit/c1692d4b4a61c6d141306918c846e59efe3ecc84))
* **api-security:** thread LLM token usage into request log (B0-117) ([5d1fb29](https://github.com/betcocorp/bex2.0/commit/5d1fb293220d2dc41a860b6f6f253d77bc7fa1ac))
* **api:** add /api/v1/tools registry + wire web-search into withApiV1 [B0-241/B0-242] ([73a8236](https://github.com/betcocorp/bex2.0/commit/73a8236db24b93bb25441a8605f219da6de0be26))
* **api:** expose web search as a client-authenticated v1 tool ([789df5c](https://github.com/betcocorp/bex2.0/commit/789df5c5461503a9cace9c9802b7be382407b6b7))
* B0-183 deterministic web-search fallback on cross-reference miss ([ee4b879](https://github.com/betcocorp/bex2.0/commit/ee4b879dd964dbc528b94f05792b76dc65de17fe))
* **B0-318,B0-319,B0-320,B0-321:** capture and chart time-to-first-token for test runs ([c3bfb16](https://github.com/betcocorp/bex2.0/commit/c3bfb16f17591d3ffaf1dbe00c3e629ef6a01489))
* **B0-349:** persist pre-validator draft answer on every workflow run ([d7f557e](https://github.com/betcocorp/bex2.0/commit/d7f557e38967a8e9828f0c1f5a34aded3b62959f))
* **B0-398:** add prompt-version chips to run header, runs list, and item rows ([7f7e47e](https://github.com/betcocorp/bex2.0/commit/7f7e47e139198fc8f63cfead2e609f04a333fbbf))
* **B0-399:** distinguish four run-trace empty states, centralize search-run extractors ([210f1e5](https://github.com/betcocorp/bex2.0/commit/210f1e531479b718c7435d4edfc0a3638cebb3ce))
* B0-448 conversation source column, bex.chat.view-all, test-run backfill ([932b4bd](https://github.com/betcocorp/bex2.0/commit/932b4bd8294ce062b7d884a1ecec871dbebeb8b6))
* **B0-462:** add semantic-release versioning CI for main/staging/dev ([38841f0](https://github.com/betcocorp/bex2.0/commit/38841f09bf234bbca838b8760726a476f353f045))
* **B0-462:** permissions and minor styling ([80f715f](https://github.com/betcocorp/bex2.0/commit/80f715f0791504867ff48d72a8dd34631188f586))
* **b0-95:** recommendation review & verification queue admin UI ([5c9bdd8](https://github.com/betcocorp/bex2.0/commit/5c9bdd8d580e926177af57e37887c8f2de3af235))
* **b0-96:** promote verified recommendations into fast-path xref + metrics ([4717094](https://github.com/betcocorp/bex2.0/commit/4717094a75acc2500f4e1045fc884bae4f35fa18))
* **b0-97:** threshold calibration tooling + document the real ground-truth gap ([b7eacfc](https://github.com/betcocorp/bex2.0/commit/b7eacfc1d5aaf7428828be46c8fc4c68c6d252c1))
* BO-114 ([e602c21](https://github.com/betcocorp/bex2.0/commit/e602c215f482e3b9e9fd9dd26df3c5be9346c340))
* **BO-304:** Efficacy ingestion ui reworked the ui to make more sense ([2ad40ea](https://github.com/betcocorp/bex2.0/commit/2ad40ead07423706ab800725abb9d890a7d395ab))
* BO-99 ([49c93c0](https://github.com/betcocorp/bex2.0/commit/49c93c07600db5cce3f2e3fd72a02ba0eb336598))
* **category:** admin curation UI for product→category links (B0-36) ([181e08a](https://github.com/betcocorp/bex2.0/commit/181e08a244bd6bcb1369ce4f4f08dfc58892b7b4))
* **category:** authoritative product↔category linker from betco.com scrape (B0-34) ([ba2f7fa](https://github.com/betcocorp/bex2.0/commit/ba2f7fa7dd0e961cae7e9abf4051241df633c886))
* **category:** category resolver — query -> taxonomy node + confidence (B0-27) ([809f107](https://github.com/betcocorp/bex2.0/commit/809f10763f3e1a0accb0c584e3a45043f62cc227))
* **category:** category-first router + agent tool + routing telemetry (B0-29/B0-30/B0-31) ([8c80b37](https://github.com/betcocorp/bex2.0/commit/8c80b37f22a151bec264543bc0121acc9d85ac12))
* **category:** continuous delta sync of product→category links (B0-37) ([40837d9](https://github.com/betcocorp/bex2.0/commit/40837d911642e6cd817da1b0c400f2b0964654e9))
* **category:** cross-validation report vs legacy + live site (B0-38) ([8ee2e98](https://github.com/betcocorp/bex2.0/commit/8ee2e989811b56c38b8ecf30f577a653a9e14acb))
* **category:** DB-backed taxonomy retrieval — query -> node -> products (B0-28, B0-33/B0-34 wiring) ([d1b753a](https://github.com/betcocorp/bex2.0/commit/d1b753aafc16b2d6a13675f7bd0f06f265cf4fd8))
* **category:** LLM classifier for unlinked/low-confidence prod-lines (B0-35) ([5621f68](https://github.com/betcocorp/bex2.0/commit/5621f68aca5f7233d8a51d6616bb64c87d18ce49))
* **category:** seed exact betco.com taxonomy + segregate by source (B0-33) ([9ea119d](https://github.com/betcocorp/bex2.0/commit/9ea119dc38a80ba850559a243255355404413163))
* chore cleaning up code ([bfdc4b1](https://github.com/betcocorp/bex2.0/commit/bfdc4b1e4cac10e167d1d082df161b0b16126e83))
* cleaning up ui ([856ba40](https://github.com/betcocorp/bex2.0/commit/856ba40b39c36d2260b2a7346e87eccf635e767b))
* consolidated some ui, abstracted utilities, abstracted agent definition for sanity ([1c3071e](https://github.com/betcocorp/bex2.0/commit/1c3071e67409096b701ebdc562600c23f9557b1c))
* consolidated the two cross reference pages into one with tabs ([9e53980](https://github.com/betcocorp/bex2.0/commit/9e5398069f1daef61ca5125f0e73d38b25a39f0a))
* continuing to refine context and document corpus structuring ([eee4555](https://github.com/betcocorp/bex2.0/commit/eee45559b013b851ccb23baab81d6e15b0e70eed))
* converted all code to utilize 3072 embedding over 1536 ([ea3cf11](https://github.com/betcocorp/bex2.0/commit/ea3cf11998077d3b5cc233e8ed445516f53758c7))
* converting embeddings to use 3000+ dimensions ([afc7dd2](https://github.com/betcocorp/bex2.0/commit/afc7dd2274e3f5885ef41236f5b009127aa26afa))
* download timeline json, fix corpus inex, minor ui changes ([4f180bd](https://github.com/betcocorp/bex2.0/commit/4f180bda71d8c23b22ce1d74c3a85978b8fb1803))
* **efficacy/labels:** generalize ingestion pipeline, add chunking RPC, schema, retrieval enhancements [B0-227-238, B0-256-283] ([47ab061](https://github.com/betcocorp/bex2.0/commit/47ab0619d45df00c8f2b057048ae2f1f4154c645))
* **efficacy/tools:** implement deterministic dilution lookup with RAG database integration [B0-288] ([67d23b5](https://github.com/betcocorp/bex2.0/commit/67d23b5e83c17986ac0dc3146feb3e05d87f35f7))
* **efficacy:** cross-check and enrich the 70 converted markdown files [B0-224] ([9e40736](https://github.com/betcocorp/bex2.0/commit/9e40736c56389f996aae43921e574f86a4309d53))
* **efficacy:** new document_kind='efficacy' RAG pipeline, crosswalk, citation [B0-227..238] ([3473f11](https://github.com/betcocorp/bex2.0/commit/3473f1174cf02568073e0bd1c378aa6756a6e12b))
* **efficacy:** parse Master Efficacy Version Data into a structured table [B0-223] ([2cd8db9](https://github.com/betcocorp/bex2.0/commit/2cd8db9b4ab741e6c24c545f26e5b5ea7ad428e3))
* enhanced query tuning ([0bb87ca](https://github.com/betcocorp/bex2.0/commit/0bb87cad0560a96c14215866152d6bf06a558c4b))
* enriching data and updating RAG system ([59f118f](https://github.com/betcocorp/bex2.0/commit/59f118f15761626b479a5a8f0c9cda3c89dbe244))
* expand eval refusal detection and add product category tools ([c6724f8](https://github.com/betcocorp/bex2.0/commit/c6724f80772ac7ab8143d0e28ca9f919172f3686))
* expanding the rag search results to be include more inclusive data rather than being fragmented ([53b5050](https://github.com/betcocorp/bex2.0/commit/53b50501d708e16dbf4b5b2f2916bcda9756c361))
* ingesting more efficacy docs, fixing bugs from migration and resolving new efficacy mappings ([2178dd9](https://github.com/betcocorp/bex2.0/commit/2178dd9146f4c709f511202bfdf11ad0f8c5c5ff))
* ingestion of label data ([36a73e4](https://github.com/betcocorp/bex2.0/commit/36a73e443778b49984791ad3aeb9d381eee4602a))
* knowledge base ([0012449](https://github.com/betcocorp/bex2.0/commit/0012449ac739d93e366fc89661517b69e07fc438))
* **knowledge:** admin ingest panel for v1 markdown corpus (B0-187/188/189/190) ([4509adb](https://github.com/betcocorp/bex2.0/commit/4509adb56a9033658bc69741c476c0260dfdff79))
* **knowledge:** markdown-ingest foundation — S3 read, discovery, chunker ([4ffc172](https://github.com/betcocorp/bex2.0/commit/4ffc1722800ad55cfc21eb0af54481b1aac101a4))
* **labels:** validator guardrails, exact lookup tool, citations, discontinued filter [B0-257] ([25a1559](https://github.com/betcocorp/bex2.0/commit/25a155998bc0d7277abebad52743dbb9da704d96))
* migrating the remaining items to vercel ([634e9d3](https://github.com/betcocorp/bex2.0/commit/634e9d33777b88181ee06357e74e5ad661fa29df))
* migration and pipeline remapping ([e283757](https://github.com/betcocorp/bex2.0/commit/e2837578dd80ca7331cc15066a559b7c1feef455))
* minor updates for test runner ui additions ([778c175](https://github.com/betcocorp/bex2.0/commit/778c175d0041256ff74177360fdf043401f667ff))
* **orphans:** view full underlying record from the orphan queue ([d819c0e](https://github.com/betcocorp/bex2.0/commit/d819c0ec62234271c7e5efa244abc676c30e6b0e))
* performance enhancements ([7b5e06d](https://github.com/betcocorp/bex2.0/commit/7b5e06d8bcd345cab0bf105fac0e7c4b0787bbb0))
* persist anlysis of runs to db ([49c3e94](https://github.com/betcocorp/bex2.0/commit/49c3e9412c09a3e43e69c585f2dcd4f9a9498467))
* **rag/products/efficacy:** complete B0-279/281/284/286/287/289 work ([f8c67ef](https://github.com/betcocorp/bex2.0/commit/f8c67ef27a2545b6afa5fce8e2e57bc44c4aa7b2))
* **rag:** activate filter_product_key in retrieval query resolver [B0-250] ([b857e9b](https://github.com/betcocorp/bex2.0/commit/b857e9b9d2294f9a43f328fcbb0b660cff5334b6))
* **rag:** backfill active products into rag.entity as product-tier entities [B0-246] ([572ab24](https://github.com/betcocorp/bex2.0/commit/572ab244966b7b2dd90e47fb77087ae95beecefd))
* **rag:** classify product_application from category taxonomy [B0-263] ([e6735e5](https://github.com/betcocorp/bex2.0/commit/e6735e5b9e8037b8199603f826ce5b308dc9df7e))
* **rag:** enable cross-encoder reranking on product-support retrieval path [B0-280] ([8a09582](https://github.com/betcocorp/bex2.0/commit/8a095821e01a22b51f983ca26cedb67c7f2f9a72))
* **rag:** extract dilution values from directions text for 34 lines [B0-264] ([6da953e](https://github.com/betcocorp/bex2.0/commit/6da953e3ccb6c0d881c72ddcc5fe4cbd7726f4d8))
* **rag:** link active product entities to their product-line parents [B0-247] ([717c698](https://github.com/betcocorp/bex2.0/commit/717c69864a90f61ed656dae40f5b15d4bf909736))
* **rag:** link unambiguous label documents to active product entities [B0-249] ([bc809d1](https://github.com/betcocorp/bex2.0/commit/bc809d135ceee3ae71bb1a56bab87a9d0e05a848))
* **rag:** seed SKU/InvtID aliases for active products [B0-248] ([95fb31c](https://github.com/betcocorp/bex2.0/commit/95fb31c8ac61450c7a3b54ed4ac9097819b6e6bc))
* **rag:** tune HNSW ef_search + candidate pools; lock down maintenance RPC grants & search_path [B0-278/282/283] ([abeeb80](https://github.com/betcocorp/bex2.0/commit/abeeb80f832cd28b8fc118b50b6da564801eaeaf))
* rearranged ingestion ui to make more sense in additional ingestion pages and removed working docs from claude ([fc860f1](https://github.com/betcocorp/bex2.0/commit/fc860f1c94c2431334ad641e690773b1af529ab8))
* **rec-3:** curated cross-reference override — Spartan BNC-15 → Betco Triforce (B0-46/B0-76) ([6d53017](https://github.com/betcocorp/bex2.0/commit/6d53017dee0363d49cd1fde7d13f14de7e95a6c7)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333)
* **rec:** competitive analysis + up to 2 alternatives for a curated recommendation ([6ce90bd](https://github.com/betcocorp/bex2.0/commit/6ce90bd68ee3a74be5ea5e287f7b25ff7753d2b2))
* **rec:** deterministic cross-reference override safety-net (make Triforce land) ([42ca9fe](https://github.com/betcocorp/bex2.0/commit/42ca9fe89f3a130894ed8cb040dae742032b2bbd))
* Recommendations SME agent + competitor cross-reference engine (B0-43/44/47/49/50/51) ([02af888](https://github.com/betcocorp/bex2.0/commit/02af8884d7db21ce8796936f77b9c76d35ec8497)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333)
* **recommendations:** confidence scoring + configurable threshold gate (B0-88) ([fa5b0d1](https://github.com/betcocorp/bex2.0/commit/fa5b0d1a5c95c86556a28b6f2239334c4c6c5e65))
* **recommendations:** cross-reference recommendation prompt template + output schema (B0-90) ([d1a11fa](https://github.com/betcocorp/bex2.0/commit/d1a11fa568637b300b6bf54bf9de5e5f909ba061))
* **recommendations:** guardrails for the web-grounded recommendation (B0-91) ([1f82a40](https://github.com/betcocorp/bex2.0/commit/1f82a40e5c3b447876c3b17b4f44e146b98a2968))
* **recommendations:** LLM competitor-spec enrichment on the heuristic extractor (B0-86) ([9ae36e5](https://github.com/betcocorp/bex2.0/commit/9ae36e576e35d42b702321a49e4af82f3acb1fc3))
* **recommendations:** persist every recommendation (answered + declined) (B0-89) ([87bf45d](https://github.com/betcocorp/bex2.0/commit/87bf45dcb634f37fda82dca7c4e2423c58f196c7))
* **recommendations:** rag cross-reference recommendation tables (B0-82) ([e46f57a](https://github.com/betcocorp/bex2.0/commit/e46f57a0722d3f1a893c0c98271696ac86841be6))
* **recommendations:** recommendation API endpoint + tester UI (B0-94) ([762c1e3](https://github.com/betcocorp/bex2.0/commit/762c1e3baec875928af21c3da9601b31c43b9328))
* **recommendations:** recommendCrossReference() orchestrator, legacy-first + web fallback (B0-85) ([d812f9f](https://github.com/betcocorp/bex2.0/commit/d812f9fedd61cb6e694cf19bdf26ff3f20d01eac))
* **recommendations:** retrieve N Betco candidates from the enriched spec (B0-87) ([09778ce](https://github.com/betcocorp/bex2.0/commit/09778ce9e761d7a76efe52601c50b3749359edd4))
* **recommendations:** web-search cost/domain/rate guardrails (B0-92) ([ebaf14e](https://github.com/betcocorp/bex2.0/commit/ebaf14ebd989b141e57591a49a5b80b8b41be677))
* **recommendations:** wire recommend_cross_reference agent tool into the workflow (B0-93) ([217db0b](https://github.com/betcocorp/bex2.0/commit/217db0b42fe4e60b6587b81bd84ae37ad6afe90f))
* **recommendations:** Zod contracts + repository for cross-reference recommendations (B0-83) ([543958d](https://github.com/betcocorp/bex2.0/commit/543958df135300873d2d722826b704a2ea0468b4))
* reconciling new data from 1.0 ([8203229](https://github.com/betcocorp/bex2.0/commit/8203229d5a37677a6cc1352751524554847024f9))
* restructuring chunks for embedding ([9d847d9](https://github.com/betcocorp/bex2.0/commit/9d847d9967dbc260b66e443026422d0f2c0c4b6b))
* **retrieval:** fetch structured product facts + attach to query result (B0-195) ([07bfa7c](https://github.com/betcocorp/bex2.0/commit/07bfa7c645a78d8932b1005c43fc7ed72bf5cd1b))
* **retrieval:** intent-driven curation knobs (B0-201) ([d7c5493](https://github.com/betcocorp/bex2.0/commit/d7c5493937e409fc7c17a5a167384b6f8aa34c28))
* **retrieval:** near-duplicate suppression across sources [B0-257] ([9fa2cfc](https://github.com/betcocorp/bex2.0/commit/9fa2cfc1fc8c974ba65fd224a1df375352c6c158))
* **retrieval:** product alias table resolution (B0-200) ([b3a7b7f](https://github.com/betcocorp/bex2.0/commit/b3a7b7f8041cbdfe85f401820a7ea7dd90bc1112))
* **retrieval:** surface knowledge chunks in curated results (B0-191) ([e162eb0](https://github.com/betcocorp/bex2.0/commit/e162eb0754c671a78087657003cd9d839cbe2e5e))
* **sds:** scope SDS corpus discovery to policy + content-based language check [B0-243] ([83b3636](https://github.com/betcocorp/bex2.0/commit/83b36368b78d12edcdafa6a6581ecf7716ba30af))
* starting api security work ([ab270e4](https://github.com/betcocorp/bex2.0/commit/ab270e4089c875bba5c0be854e95bf83a59b7a9a))
* test runner suite ([fb517d5](https://github.com/betcocorp/bex2.0/commit/fb517d5b2d6b60b3e1bc631487686bcd9b997fb9))
* **tools:** get_efficacy_data fact-only tool + route dilution/kill-claim intents (B0-197) ([894e33b](https://github.com/betcocorp/bex2.0/commit/894e33b0d1f4f005992cf74374f32b439bba5693))
* **tools:** ground answers on structured facts (B0-196) ([3e3a9a3](https://github.com/betcocorp/bex2.0/commit/3e3a9a31ce930403c8f8c67537b729d7ae97f315))
* tuning the search to optimize both for product data and sds ([6c5d4b5](https://github.com/betcocorp/bex2.0/commit/6c5d4b52678fca96f47f4e9d679e961df0d2d51b))
* tweaking workflows and updating ui responses ([da92099](https://github.com/betcocorp/bex2.0/commit/da92099391273810cbf7d1d4cbed0ffffff9f646))
* ui feature enhancements, new tool product cross reference tool ([f79705f](https://github.com/betcocorp/bex2.0/commit/f79705f87c3e628abd1ce93f2b0332582140c0dc))
* updating code based on docs and specifications already developed ([5b5dcda](https://github.com/betcocorp/bex2.0/commit/5b5dcdae1e04e47a073bf765b16aa81d0ccb29bc))
* updating data, add prompt, remove ([4af379d](https://github.com/betcocorp/bex2.0/commit/4af379db6c8b7f79912e9f00c3de62bb1f495339))
* vercel migration minor ui changes ([e35820a](https://github.com/betcocorp/bex2.0/commit/e35820ad0a6b6bd844bfa17d70644459495af21e))
* web search caching + competitor-spec extraction (B0-55, B0-54) ([28d582b](https://github.com/betcocorp/bex2.0/commit/28d582b2bb4b5bcafa0058573ec5e05eecdad73e))
* web search capability + admin test harness (B0-70) ([485c3d0](https://github.com/betcocorp/bex2.0/commit/485c3d00c4be7e81ee4cc0da45f623d88e0e69ad))
* **websearch:** durable DB-backed response cache (memory -> DB -> provider) ([1a0770b](https://github.com/betcocorp/bex2.0/commit/1a0770b5c15950817897e517fcfa93608ea8d0d6))
* **websearch:** external citation surface in agent output (WEB-6) ([8b80ad3](https://github.com/betcocorp/bex2.0/commit/8b80ad3ac8e190705b01067dae5ef398db90ae12))
* **websearch:** source-trust policy (WEB-2) + guardrails/cost controls (WEB-5) ([7b64c95](https://github.com/betcocorp/bex2.0/commit/7b64c95ce2783bd4162b0d69f0e1d50d82b163cf))
* working on data migration and initial vector embeddings ([59db37e](https://github.com/betcocorp/bex2.0/commit/59db37eed541b4bc06688e8b36a3b95ec21af2b2))
* working on first implementation of sub agents ([5c2fb3d](https://github.com/betcocorp/bex2.0/commit/5c2fb3db56f75587945355439982617149cf0300))

# 1.0.0 (2026-08-14)


### Bug Fixes

* **api-security:** require NextAuth session on /api/admin/tests/* routes ([52734d0](https://github.com/betcocorp/bex2.0/commit/52734d005712406a008c635e63d509dd58a67870))
* **b0-13:** surface chunk ids for retrieval auditing; investigate missed virus claims ([79d90d4](https://github.com/betcocorp/bex2.0/commit/79d90d490f2984406da60039fe23b344b6cb85b5))
* **b0-244:** undefined `KnowledgeChunk` type → `MarkdownChunk` ([27f60b2](https://github.com/betcocorp/bex2.0/commit/27f60b2cadf239d56301adb5eb55830e93cfffb7))
* **b0-272:** prose fallback for efficacy questions + tokenized product-name resolver ([534a9ad](https://github.com/betcocorp/bex2.0/commit/534a9ad59b53dc5b719875fc21939564da49b863))
* **b0-272:** stop hard-filtering scope:'all' retrieval by inferred section_type ([1716acb](https://github.com/betcocorp/bex2.0/commit/1716acb1dd3c853b4a3ce24a9524494907900330))
* **b0-284-hotfix:** restore chunk_sds_document_text TABLE signature ([b0926d6](https://github.com/betcocorp/bex2.0/commit/b0926d6d56f841692ff6d46c2a082d501b013f28))
* **B0-462:** pin pnpm 11 for the release workflow ([bd61dd9](https://github.com/betcocorp/bex2.0/commit/bd61dd96b4b1f00e116f19dde8c6d505aef72d76))
* **database:** add RLS policies to security-less tables & document view security [B0-284, B0-285] ([cb2d432](https://github.com/betcocorp/bex2.0/commit/cb2d432e9997e9a411393f5ef0aa62002ab71c27))
* **efficacy:** make structured efficacy answers work end-to-end ([3425a92](https://github.com/betcocorp/bex2.0/commit/3425a9243fc4ea105c4d703d7d3cf6433009ed32))
* for duplicate key ([748681b](https://github.com/betcocorp/bex2.0/commit/748681b6e2cdda5c523adf9b5c84a3dc80a20249))
* keep the service-token path open on /api/bex/workflow-runs/[id] ([1565177](https://github.com/betcocorp/bex2.0/commit/1565177a3134469d9e044a483524417d4b945c1b))
* **knowledge:** fall back to generic AWS read keys for retool-360 (B0-187) ([080f893](https://github.com/betcocorp/bex2.0/commit/080f89333beb18e1116562c10894abec81a38d33))
* **knowledge:** report ingested status from real chunk counts (B0-188) ([0988352](https://github.com/betcocorp/bex2.0/commit/098835212543c8b434580a02b446d7b8da2a0d6d))
* **migrations:** drop all function overloads before recreate [B0-284] ([e0768a9](https://github.com/betcocorp/bex2.0/commit/e0768a98e5474514704d6bb81dd44536c31adf9f))
* **migrations:** wrap bare RAISE in DO block [B0-284] ([dffc690](https://github.com/betcocorp/bex2.0/commit/dffc690d05164a37187a501d5865159bbfabd08f))
* **na:** let BEX_DISABLE_CONFIDENCE_GATING also bypass regulated-claim grounding and chemistry-mismatch ([d35b0bb](https://github.com/betcocorp/bex2.0/commit/d35b0bb5e9486f1c555ba5f8bc4071469c0228ad))
* **na:** remove duplicate PERMISSIONS keys causing TS1117 and permission-check breakage ([629b54f](https://github.com/betcocorp/bex2.0/commit/629b54f1611a3583b4114a562b26476a703e5bdc))
* **rag:** add filter_product_key to match_corpus_chunks(_hybrid) [B0-250 correction] ([3478014](https://github.com/betcocorp/bex2.0/commit/3478014d2258af8ea3afd7cb4f0f12a9d832cb6d))
* **rag:** correct overload drops for match_product_chunks functions [B0-281] ([a6c688e](https://github.com/betcocorp/bex2.0/commit/a6c688e3fefa299f9b0f52d4d1aa376ffddb482b))
* **rag:** disambiguate dilution_code='0' sentinel into RTU vs missing [B0-265] ([72a5e2d](https://github.com/betcocorp/bex2.0/commit/72a5e2dc1d1eb34746f8f06e14257c55ac3c1569))
* **rag:** disambiguate match_product_chunks_hybrid overload (42725) ([00ef5e6](https://github.com/betcocorp/bex2.0/commit/00ef5e685358f0bbaa068a7c957973d7cacc3260))
* **rag:** drop match_product_chunks overloads before audit [B0-281] ([8fab804](https://github.com/betcocorp/bex2.0/commit/8fab8041b583f69d94281d877ffbf5e54fea5937))
* **rag:** raise statement_timeout on hybrid match RPCs (B0-217) ([df0f156](https://github.com/betcocorp/bex2.0/commit/df0f15654582f74975137dd5fa6bcb563c44c2d3))
* **rag:** stop empty heading-only knowledge chunks from being embedded ([7059665](https://github.com/betcocorp/bex2.0/commit/70596659414360ad7dd410aabc8afa5a461cc3fb))
* **rec:** don't let a validator-revision refusal overwrite a good answer ([fbf644d](https://github.com/betcocorp/bex2.0/commit/fbf644de79c99cdbeeaac989afe84453049b753c))
* **rec:** ground competitor by chemistry + search by capability on cross-ref miss ([659ec92](https://github.com/betcocorp/bex2.0/commit/659ec929d8d49ed8998c36b37edbe5adcb5fb519)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333) [#1](https://github.com/betcocorp/bex2.0/issues/1)
* **rec:** stop forcing the validator on the recommendations route (it was nuking answers) ([f4a6d3e](https://github.com/betcocorp/bex2.0/commit/f4a6d3e367789713581d64ba3597aa02f753b234))
* **rec:** stop stapling a comparable-product headline onto a decline; force validator on rec route ([475d062](https://github.com/betcocorp/bex2.0/commit/475d0623f52d6b52551816a71537860e526fcaa3))
* **rec:** validator must not reject/overwrite a cross-reference recommendation ([3b6c197](https://github.com/betcocorp/bex2.0/commit/3b6c197f5a98358d604543d8fa45e25802d49f3d))
* **tests,rag:** grader decline detection, per-run model, hybrid + knowledge/label scopes ([5c44d6e](https://github.com/betcocorp/bex2.0/commit/5c44d6e07b8366bf1ab9863c1c0c5f793ba8cde2))
* un-ignore src/supabase so new migrations are actually tracked ([8d97504](https://github.com/betcocorp/bex2.0/commit/8d97504f7461b26a105debbd642f00bef957ffb2))


### Features

* add initial app code ([9d5bfa1](https://github.com/betcocorp/bex2.0/commit/9d5bfa1c303462d9face65303fc5029607f08ecf))
* added api test for calling web search tool using new token system ([a5fde6c](https://github.com/betcocorp/bex2.0/commit/a5fde6c946200c1b46fdb09f2757ad434b23a4f9))
* added mew chart ([4718a85](https://github.com/betcocorp/bex2.0/commit/4718a850befbd77c7e05d55595b053f5041c82b1))
* added more shadcn components ([ba27c26](https://github.com/betcocorp/bex2.0/commit/ba27c26b43620ecf8498495490750aca939c0273))
* adding auth ([45e1e5d](https://github.com/betcocorp/bex2.0/commit/45e1e5d466d71ce070fbe4836929ceed416c5ded))
* adding failed queue ([4b627f6](https://github.com/betcocorp/bex2.0/commit/4b627f6a6c0913bf082ca5b2151a87da647931f9))
* adding initial routing and orchestration ([766ae4c](https://github.com/betcocorp/bex2.0/commit/766ae4cde2f9d90a6668f31a52c9c6864287d3fb))
* adding more code to customize logic and functionality ([fa96e4c](https://github.com/betcocorp/bex2.0/commit/fa96e4c9aa8961dcbf1d738e2272340a78809b9f))
* adding more reporting and observability to the search ([29d7374](https://github.com/betcocorp/bex2.0/commit/29d7374fdf8dc6bb47f2c3d70c6d2cbad7a4af16))
* adding more reporting fine tuning. Adding other funcctionality to support workflow along with additional reporting ([b5b24fe](https://github.com/betcocorp/bex2.0/commit/b5b24fe944f92c331416d83931af346b3a07dbd7))
* adding more ui and refining views further ([2fff2b5](https://github.com/betcocorp/bex2.0/commit/2fff2b5779b6866d1ee39ff6a07b5678fb345552))
* adding sentry ([e2a0030](https://github.com/betcocorp/bex2.0/commit/e2a00309f2eeecf52e96efcd773afd7a9ef58b63))
* adding variable similarity threshold to search ([8a15332](https://github.com/betcocorp/bex2.0/commit/8a1533206649ffab7b6c035033fc9a214d95026a))
* **admin:** add Web search card to the /admin/tools landing page ([421361e](https://github.com/betcocorp/bex2.0/commit/421361e86ecdf18660210d366d4495f56427a8d4))
* **admin:** cached web-search results table in /admin/tools/web-search (B0-109) ([adb321d](https://github.com/betcocorp/bex2.0/commit/adb321d92d66d9881abece931e6494834e2f297a))
* **admin:** Orphan Monitor + product-line backfill migration [B0-267] ([d7b193d](https://github.com/betcocorp/bex2.0/commit/d7b193d5eb176fce0a2c78bcb1dfa4989975af92))
* **admin:** show web-search cache duration in Cached results subtext ([9b3f8e7](https://github.com/betcocorp/bex2.0/commit/9b3f8e7e5833d547474147ca2f03ea74f3a62636))
* **api-security:** admin projects list + create wizard (B0-116) ([4aff4d2](https://github.com/betcocorp/bex2.0/commit/4aff4d2c784df6404a2503a56ced6237e10a782e))
* **api-security:** API analytics dashboard (B0-120) ([7a88b13](https://github.com/betcocorp/bex2.0/commit/7a88b137aefb5f3200bdfb3aaffaa86b95b5aee4))
* **api-security:** app detail — tokens, rotation, kill switch, rate limit (B0-118) ([6227e1b](https://github.com/betcocorp/bex2.0/commit/6227e1bfd053c9965d5d58c903540308b71ab575))
* **api-security:** enforce per-client token on all /api/v1/* + delete legacy auth (B0-115) ([48cdf14](https://github.com/betcocorp/bex2.0/commit/48cdf14e78fca6553f8f6a7b0b347e5ed53af651))
* **api-security:** per-app rate limiting (429 + Retry-After) (B0-119) ([31fe4c3](https://github.com/betcocorp/bex2.0/commit/31fe4c386f25b1dc11bd5641c3ea45ff8a5fd08b))
* **api-security:** per-request logging + last-used tracking for /api/v1/* (B0-117) ([4e1d942](https://github.com/betcocorp/bex2.0/commit/4e1d942e0c3a80af868ede76edecf1e100a58762))
* **api-security:** project detail — apps, add app, kill switch (B0-130) ([9893c31](https://github.com/betcocorp/bex2.0/commit/9893c31be3095527d748f38af35db2671920ebd8))
* **api-security:** require NextAuth session on all /api/bex/* routes (B0-114) ([c1692d4](https://github.com/betcocorp/bex2.0/commit/c1692d4b4a61c6d141306918c846e59efe3ecc84))
* **api-security:** thread LLM token usage into request log (B0-117) ([5d1fb29](https://github.com/betcocorp/bex2.0/commit/5d1fb293220d2dc41a860b6f6f253d77bc7fa1ac))
* **api:** add /api/v1/tools registry + wire web-search into withApiV1 [B0-241/B0-242] ([73a8236](https://github.com/betcocorp/bex2.0/commit/73a8236db24b93bb25441a8605f219da6de0be26))
* **api:** expose web search as a client-authenticated v1 tool ([789df5c](https://github.com/betcocorp/bex2.0/commit/789df5c5461503a9cace9c9802b7be382407b6b7))
* B0-183 deterministic web-search fallback on cross-reference miss ([ee4b879](https://github.com/betcocorp/bex2.0/commit/ee4b879dd964dbc528b94f05792b76dc65de17fe))
* **B0-318,B0-319,B0-320,B0-321:** capture and chart time-to-first-token for test runs ([c3bfb16](https://github.com/betcocorp/bex2.0/commit/c3bfb16f17591d3ffaf1dbe00c3e629ef6a01489))
* **B0-349:** persist pre-validator draft answer on every workflow run ([d7f557e](https://github.com/betcocorp/bex2.0/commit/d7f557e38967a8e9828f0c1f5a34aded3b62959f))
* **B0-398:** add prompt-version chips to run header, runs list, and item rows ([7f7e47e](https://github.com/betcocorp/bex2.0/commit/7f7e47e139198fc8f63cfead2e609f04a333fbbf))
* **B0-399:** distinguish four run-trace empty states, centralize search-run extractors ([210f1e5](https://github.com/betcocorp/bex2.0/commit/210f1e531479b718c7435d4edfc0a3638cebb3ce))
* B0-448 conversation source column, bex.chat.view-all, test-run backfill ([932b4bd](https://github.com/betcocorp/bex2.0/commit/932b4bd8294ce062b7d884a1ecec871dbebeb8b6))
* **B0-462:** add semantic-release versioning CI for main/staging/dev ([38841f0](https://github.com/betcocorp/bex2.0/commit/38841f09bf234bbca838b8760726a476f353f045))
* **B0-462:** permissions and minor styling ([80f715f](https://github.com/betcocorp/bex2.0/commit/80f715f0791504867ff48d72a8dd34631188f586))
* **b0-95:** recommendation review & verification queue admin UI ([5c9bdd8](https://github.com/betcocorp/bex2.0/commit/5c9bdd8d580e926177af57e37887c8f2de3af235))
* **b0-96:** promote verified recommendations into fast-path xref + metrics ([4717094](https://github.com/betcocorp/bex2.0/commit/4717094a75acc2500f4e1045fc884bae4f35fa18))
* **b0-97:** threshold calibration tooling + document the real ground-truth gap ([b7eacfc](https://github.com/betcocorp/bex2.0/commit/b7eacfc1d5aaf7428828be46c8fc4c68c6d252c1))
* BO-114 ([e602c21](https://github.com/betcocorp/bex2.0/commit/e602c215f482e3b9e9fd9dd26df3c5be9346c340))
* **BO-304:** Efficacy ingestion ui reworked the ui to make more sense ([2ad40ea](https://github.com/betcocorp/bex2.0/commit/2ad40ead07423706ab800725abb9d890a7d395ab))
* BO-99 ([49c93c0](https://github.com/betcocorp/bex2.0/commit/49c93c07600db5cce3f2e3fd72a02ba0eb336598))
* **category:** admin curation UI for product→category links (B0-36) ([181e08a](https://github.com/betcocorp/bex2.0/commit/181e08a244bd6bcb1369ce4f4f08dfc58892b7b4))
* **category:** authoritative product↔category linker from betco.com scrape (B0-34) ([ba2f7fa](https://github.com/betcocorp/bex2.0/commit/ba2f7fa7dd0e961cae7e9abf4051241df633c886))
* **category:** category resolver — query -> taxonomy node + confidence (B0-27) ([809f107](https://github.com/betcocorp/bex2.0/commit/809f10763f3e1a0accb0c584e3a45043f62cc227))
* **category:** category-first router + agent tool + routing telemetry (B0-29/B0-30/B0-31) ([8c80b37](https://github.com/betcocorp/bex2.0/commit/8c80b37f22a151bec264543bc0121acc9d85ac12))
* **category:** continuous delta sync of product→category links (B0-37) ([40837d9](https://github.com/betcocorp/bex2.0/commit/40837d911642e6cd817da1b0c400f2b0964654e9))
* **category:** cross-validation report vs legacy + live site (B0-38) ([8ee2e98](https://github.com/betcocorp/bex2.0/commit/8ee2e989811b56c38b8ecf30f577a653a9e14acb))
* **category:** DB-backed taxonomy retrieval — query -> node -> products (B0-28, B0-33/B0-34 wiring) ([d1b753a](https://github.com/betcocorp/bex2.0/commit/d1b753aafc16b2d6a13675f7bd0f06f265cf4fd8))
* **category:** LLM classifier for unlinked/low-confidence prod-lines (B0-35) ([5621f68](https://github.com/betcocorp/bex2.0/commit/5621f68aca5f7233d8a51d6616bb64c87d18ce49))
* **category:** seed exact betco.com taxonomy + segregate by source (B0-33) ([9ea119d](https://github.com/betcocorp/bex2.0/commit/9ea119dc38a80ba850559a243255355404413163))
* chore cleaning up code ([bfdc4b1](https://github.com/betcocorp/bex2.0/commit/bfdc4b1e4cac10e167d1d082df161b0b16126e83))
* cleaning up ui ([856ba40](https://github.com/betcocorp/bex2.0/commit/856ba40b39c36d2260b2a7346e87eccf635e767b))
* consolidated some ui, abstracted utilities, abstracted agent definition for sanity ([1c3071e](https://github.com/betcocorp/bex2.0/commit/1c3071e67409096b701ebdc562600c23f9557b1c))
* consolidated the two cross reference pages into one with tabs ([9e53980](https://github.com/betcocorp/bex2.0/commit/9e5398069f1daef61ca5125f0e73d38b25a39f0a))
* continuing to refine context and document corpus structuring ([eee4555](https://github.com/betcocorp/bex2.0/commit/eee45559b013b851ccb23baab81d6e15b0e70eed))
* converted all code to utilize 3072 embedding over 1536 ([ea3cf11](https://github.com/betcocorp/bex2.0/commit/ea3cf11998077d3b5cc233e8ed445516f53758c7))
* converting embeddings to use 3000+ dimensions ([afc7dd2](https://github.com/betcocorp/bex2.0/commit/afc7dd2274e3f5885ef41236f5b009127aa26afa))
* download timeline json, fix corpus inex, minor ui changes ([4f180bd](https://github.com/betcocorp/bex2.0/commit/4f180bda71d8c23b22ce1d74c3a85978b8fb1803))
* **efficacy/labels:** generalize ingestion pipeline, add chunking RPC, schema, retrieval enhancements [B0-227-238, B0-256-283] ([47ab061](https://github.com/betcocorp/bex2.0/commit/47ab0619d45df00c8f2b057048ae2f1f4154c645))
* **efficacy/tools:** implement deterministic dilution lookup with RAG database integration [B0-288] ([67d23b5](https://github.com/betcocorp/bex2.0/commit/67d23b5e83c17986ac0dc3146feb3e05d87f35f7))
* **efficacy:** cross-check and enrich the 70 converted markdown files [B0-224] ([9e40736](https://github.com/betcocorp/bex2.0/commit/9e40736c56389f996aae43921e574f86a4309d53))
* **efficacy:** new document_kind='efficacy' RAG pipeline, crosswalk, citation [B0-227..238] ([3473f11](https://github.com/betcocorp/bex2.0/commit/3473f1174cf02568073e0bd1c378aa6756a6e12b))
* **efficacy:** parse Master Efficacy Version Data into a structured table [B0-223] ([2cd8db9](https://github.com/betcocorp/bex2.0/commit/2cd8db9b4ab741e6c24c545f26e5b5ea7ad428e3))
* enhanced query tuning ([0bb87ca](https://github.com/betcocorp/bex2.0/commit/0bb87cad0560a96c14215866152d6bf06a558c4b))
* enriching data and updating RAG system ([59f118f](https://github.com/betcocorp/bex2.0/commit/59f118f15761626b479a5a8f0c9cda3c89dbe244))
* expand eval refusal detection and add product category tools ([c6724f8](https://github.com/betcocorp/bex2.0/commit/c6724f80772ac7ab8143d0e28ca9f919172f3686))
* expanding the rag search results to be include more inclusive data rather than being fragmented ([53b5050](https://github.com/betcocorp/bex2.0/commit/53b50501d708e16dbf4b5b2f2916bcda9756c361))
* ingesting more efficacy docs, fixing bugs from migration and resolving new efficacy mappings ([2178dd9](https://github.com/betcocorp/bex2.0/commit/2178dd9146f4c709f511202bfdf11ad0f8c5c5ff))
* ingestion of label data ([36a73e4](https://github.com/betcocorp/bex2.0/commit/36a73e443778b49984791ad3aeb9d381eee4602a))
* knowledge base ([0012449](https://github.com/betcocorp/bex2.0/commit/0012449ac739d93e366fc89661517b69e07fc438))
* **knowledge:** admin ingest panel for v1 markdown corpus (B0-187/188/189/190) ([4509adb](https://github.com/betcocorp/bex2.0/commit/4509adb56a9033658bc69741c476c0260dfdff79))
* **knowledge:** markdown-ingest foundation — S3 read, discovery, chunker ([4ffc172](https://github.com/betcocorp/bex2.0/commit/4ffc1722800ad55cfc21eb0af54481b1aac101a4))
* **labels:** validator guardrails, exact lookup tool, citations, discontinued filter [B0-257] ([25a1559](https://github.com/betcocorp/bex2.0/commit/25a155998bc0d7277abebad52743dbb9da704d96))
* migrating the remaining items to vercel ([634e9d3](https://github.com/betcocorp/bex2.0/commit/634e9d33777b88181ee06357e74e5ad661fa29df))
* migration and pipeline remapping ([e283757](https://github.com/betcocorp/bex2.0/commit/e2837578dd80ca7331cc15066a559b7c1feef455))
* minor updates for test runner ui additions ([778c175](https://github.com/betcocorp/bex2.0/commit/778c175d0041256ff74177360fdf043401f667ff))
* **orphans:** view full underlying record from the orphan queue ([d819c0e](https://github.com/betcocorp/bex2.0/commit/d819c0ec62234271c7e5efa244abc676c30e6b0e))
* performance enhancements ([7b5e06d](https://github.com/betcocorp/bex2.0/commit/7b5e06d8bcd345cab0bf105fac0e7c4b0787bbb0))
* persist anlysis of runs to db ([49c3e94](https://github.com/betcocorp/bex2.0/commit/49c3e9412c09a3e43e69c585f2dcd4f9a9498467))
* **rag/products/efficacy:** complete B0-279/281/284/286/287/289 work ([f8c67ef](https://github.com/betcocorp/bex2.0/commit/f8c67ef27a2545b6afa5fce8e2e57bc44c4aa7b2))
* **rag:** activate filter_product_key in retrieval query resolver [B0-250] ([b857e9b](https://github.com/betcocorp/bex2.0/commit/b857e9b9d2294f9a43f328fcbb0b660cff5334b6))
* **rag:** backfill active products into rag.entity as product-tier entities [B0-246] ([572ab24](https://github.com/betcocorp/bex2.0/commit/572ab244966b7b2dd90e47fb77087ae95beecefd))
* **rag:** classify product_application from category taxonomy [B0-263] ([e6735e5](https://github.com/betcocorp/bex2.0/commit/e6735e5b9e8037b8199603f826ce5b308dc9df7e))
* **rag:** enable cross-encoder reranking on product-support retrieval path [B0-280] ([8a09582](https://github.com/betcocorp/bex2.0/commit/8a095821e01a22b51f983ca26cedb67c7f2f9a72))
* **rag:** extract dilution values from directions text for 34 lines [B0-264] ([6da953e](https://github.com/betcocorp/bex2.0/commit/6da953e3ccb6c0d881c72ddcc5fe4cbd7726f4d8))
* **rag:** link active product entities to their product-line parents [B0-247] ([717c698](https://github.com/betcocorp/bex2.0/commit/717c69864a90f61ed656dae40f5b15d4bf909736))
* **rag:** link unambiguous label documents to active product entities [B0-249] ([bc809d1](https://github.com/betcocorp/bex2.0/commit/bc809d135ceee3ae71bb1a56bab87a9d0e05a848))
* **rag:** seed SKU/InvtID aliases for active products [B0-248] ([95fb31c](https://github.com/betcocorp/bex2.0/commit/95fb31c8ac61450c7a3b54ed4ac9097819b6e6bc))
* **rag:** tune HNSW ef_search + candidate pools; lock down maintenance RPC grants & search_path [B0-278/282/283] ([abeeb80](https://github.com/betcocorp/bex2.0/commit/abeeb80f832cd28b8fc118b50b6da564801eaeaf))
* rearranged ingestion ui to make more sense in additional ingestion pages and removed working docs from claude ([fc860f1](https://github.com/betcocorp/bex2.0/commit/fc860f1c94c2431334ad641e690773b1af529ab8))
* **rec-3:** curated cross-reference override — Spartan BNC-15 → Betco Triforce (B0-46/B0-76) ([6d53017](https://github.com/betcocorp/bex2.0/commit/6d53017dee0363d49cd1fde7d13f14de7e95a6c7)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333)
* **rec:** competitive analysis + up to 2 alternatives for a curated recommendation ([6ce90bd](https://github.com/betcocorp/bex2.0/commit/6ce90bd68ee3a74be5ea5e287f7b25ff7753d2b2))
* **rec:** deterministic cross-reference override safety-net (make Triforce land) ([42ca9fe](https://github.com/betcocorp/bex2.0/commit/42ca9fe89f3a130894ed8cb040dae742032b2bbd))
* Recommendations SME agent + competitor cross-reference engine (B0-43/44/47/49/50/51) ([02af888](https://github.com/betcocorp/bex2.0/commit/02af8884d7db21ce8796936f77b9c76d35ec8497)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333)
* **recommendations:** confidence scoring + configurable threshold gate (B0-88) ([fa5b0d1](https://github.com/betcocorp/bex2.0/commit/fa5b0d1a5c95c86556a28b6f2239334c4c6c5e65))
* **recommendations:** cross-reference recommendation prompt template + output schema (B0-90) ([d1a11fa](https://github.com/betcocorp/bex2.0/commit/d1a11fa568637b300b6bf54bf9de5e5f909ba061))
* **recommendations:** guardrails for the web-grounded recommendation (B0-91) ([1f82a40](https://github.com/betcocorp/bex2.0/commit/1f82a40e5c3b447876c3b17b4f44e146b98a2968))
* **recommendations:** LLM competitor-spec enrichment on the heuristic extractor (B0-86) ([9ae36e5](https://github.com/betcocorp/bex2.0/commit/9ae36e576e35d42b702321a49e4af82f3acb1fc3))
* **recommendations:** persist every recommendation (answered + declined) (B0-89) ([87bf45d](https://github.com/betcocorp/bex2.0/commit/87bf45dcb634f37fda82dca7c4e2423c58f196c7))
* **recommendations:** rag cross-reference recommendation tables (B0-82) ([e46f57a](https://github.com/betcocorp/bex2.0/commit/e46f57a0722d3f1a893c0c98271696ac86841be6))
* **recommendations:** recommendation API endpoint + tester UI (B0-94) ([762c1e3](https://github.com/betcocorp/bex2.0/commit/762c1e3baec875928af21c3da9601b31c43b9328))
* **recommendations:** recommendCrossReference() orchestrator, legacy-first + web fallback (B0-85) ([d812f9f](https://github.com/betcocorp/bex2.0/commit/d812f9fedd61cb6e694cf19bdf26ff3f20d01eac))
* **recommendations:** retrieve N Betco candidates from the enriched spec (B0-87) ([09778ce](https://github.com/betcocorp/bex2.0/commit/09778ce9e761d7a76efe52601c50b3749359edd4))
* **recommendations:** web-search cost/domain/rate guardrails (B0-92) ([ebaf14e](https://github.com/betcocorp/bex2.0/commit/ebaf14ebd989b141e57591a49a5b80b8b41be677))
* **recommendations:** wire recommend_cross_reference agent tool into the workflow (B0-93) ([217db0b](https://github.com/betcocorp/bex2.0/commit/217db0b42fe4e60b6587b81bd84ae37ad6afe90f))
* **recommendations:** Zod contracts + repository for cross-reference recommendations (B0-83) ([543958d](https://github.com/betcocorp/bex2.0/commit/543958df135300873d2d722826b704a2ea0468b4))
* reconciling new data from 1.0 ([8203229](https://github.com/betcocorp/bex2.0/commit/8203229d5a37677a6cc1352751524554847024f9))
* restructuring chunks for embedding ([9d847d9](https://github.com/betcocorp/bex2.0/commit/9d847d9967dbc260b66e443026422d0f2c0c4b6b))
* **retrieval:** fetch structured product facts + attach to query result (B0-195) ([07bfa7c](https://github.com/betcocorp/bex2.0/commit/07bfa7c645a78d8932b1005c43fc7ed72bf5cd1b))
* **retrieval:** intent-driven curation knobs (B0-201) ([d7c5493](https://github.com/betcocorp/bex2.0/commit/d7c5493937e409fc7c17a5a167384b6f8aa34c28))
* **retrieval:** near-duplicate suppression across sources [B0-257] ([9fa2cfc](https://github.com/betcocorp/bex2.0/commit/9fa2cfc1fc8c974ba65fd224a1df375352c6c158))
* **retrieval:** product alias table resolution (B0-200) ([b3a7b7f](https://github.com/betcocorp/bex2.0/commit/b3a7b7f8041cbdfe85f401820a7ea7dd90bc1112))
* **retrieval:** surface knowledge chunks in curated results (B0-191) ([e162eb0](https://github.com/betcocorp/bex2.0/commit/e162eb0754c671a78087657003cd9d839cbe2e5e))
* **sds:** scope SDS corpus discovery to policy + content-based language check [B0-243] ([83b3636](https://github.com/betcocorp/bex2.0/commit/83b36368b78d12edcdafa6a6581ecf7716ba30af))
* starting api security work ([ab270e4](https://github.com/betcocorp/bex2.0/commit/ab270e4089c875bba5c0be854e95bf83a59b7a9a))
* test runner suite ([fb517d5](https://github.com/betcocorp/bex2.0/commit/fb517d5b2d6b60b3e1bc631487686bcd9b997fb9))
* **tools:** get_efficacy_data fact-only tool + route dilution/kill-claim intents (B0-197) ([894e33b](https://github.com/betcocorp/bex2.0/commit/894e33b0d1f4f005992cf74374f32b439bba5693))
* **tools:** ground answers on structured facts (B0-196) ([3e3a9a3](https://github.com/betcocorp/bex2.0/commit/3e3a9a31ce930403c8f8c67537b729d7ae97f315))
* tuning the search to optimize both for product data and sds ([6c5d4b5](https://github.com/betcocorp/bex2.0/commit/6c5d4b52678fca96f47f4e9d679e961df0d2d51b))
* tweaking workflows and updating ui responses ([da92099](https://github.com/betcocorp/bex2.0/commit/da92099391273810cbf7d1d4cbed0ffffff9f646))
* ui feature enhancements, new tool product cross reference tool ([f79705f](https://github.com/betcocorp/bex2.0/commit/f79705f87c3e628abd1ce93f2b0332582140c0dc))
* updating code based on docs and specifications already developed ([5b5dcda](https://github.com/betcocorp/bex2.0/commit/5b5dcdae1e04e47a073bf765b16aa81d0ccb29bc))
* updating data, add prompt, remove ([4af379d](https://github.com/betcocorp/bex2.0/commit/4af379db6c8b7f79912e9f00c3de62bb1f495339))
* vercel migration minor ui changes ([e35820a](https://github.com/betcocorp/bex2.0/commit/e35820ad0a6b6bd844bfa17d70644459495af21e))
* web search caching + competitor-spec extraction (B0-55, B0-54) ([28d582b](https://github.com/betcocorp/bex2.0/commit/28d582b2bb4b5bcafa0058573ec5e05eecdad73e))
* web search capability + admin test harness (B0-70) ([485c3d0](https://github.com/betcocorp/bex2.0/commit/485c3d00c4be7e81ee4cc0da45f623d88e0e69ad))
* **websearch:** durable DB-backed response cache (memory -> DB -> provider) ([1a0770b](https://github.com/betcocorp/bex2.0/commit/1a0770b5c15950817897e517fcfa93608ea8d0d6))
* **websearch:** external citation surface in agent output (WEB-6) ([8b80ad3](https://github.com/betcocorp/bex2.0/commit/8b80ad3ac8e190705b01067dae5ef398db90ae12))
* **websearch:** source-trust policy (WEB-2) + guardrails/cost controls (WEB-5) ([7b64c95](https://github.com/betcocorp/bex2.0/commit/7b64c95ce2783bd4162b0d69f0e1d50d82b163cf))
* working on data migration and initial vector embeddings ([59db37e](https://github.com/betcocorp/bex2.0/commit/59db37eed541b4bc06688e8b36a3b95ec21af2b2))
* working on first implementation of sub agents ([5c2fb3d](https://github.com/betcocorp/bex2.0/commit/5c2fb3db56f75587945355439982617149cf0300))

# [1.0.0-dev.3](https://github.com/betcocorp/bex2.0/compare/v1.0.0-dev.2...v1.0.0-dev.3) (2026-08-14)


### Bug Fixes

* **na:** let BEX_DISABLE_CONFIDENCE_GATING also bypass regulated-claim grounding and chemistry-mismatch ([d35b0bb](https://github.com/betcocorp/bex2.0/commit/d35b0bb5e9486f1c555ba5f8bc4071469c0228ad))

# [1.0.0-dev.2](https://github.com/betcocorp/bex2.0/compare/v1.0.0-dev.1...v1.0.0-dev.2) (2026-08-14)


### Bug Fixes

* **na:** remove duplicate PERMISSIONS keys causing TS1117 and permission-check breakage ([629b54f](https://github.com/betcocorp/bex2.0/commit/629b54f1611a3583b4114a562b26476a703e5bdc))

# 1.0.0-dev.1 (2026-08-13)


### Bug Fixes

* **api-security:** require NextAuth session on /api/admin/tests/* routes ([52734d0](https://github.com/betcocorp/bex2.0/commit/52734d005712406a008c635e63d509dd58a67870))
* **b0-13:** surface chunk ids for retrieval auditing; investigate missed virus claims ([79d90d4](https://github.com/betcocorp/bex2.0/commit/79d90d490f2984406da60039fe23b344b6cb85b5))
* **b0-244:** undefined `KnowledgeChunk` type → `MarkdownChunk` ([27f60b2](https://github.com/betcocorp/bex2.0/commit/27f60b2cadf239d56301adb5eb55830e93cfffb7))
* **b0-272:** prose fallback for efficacy questions + tokenized product-name resolver ([534a9ad](https://github.com/betcocorp/bex2.0/commit/534a9ad59b53dc5b719875fc21939564da49b863))
* **b0-272:** stop hard-filtering scope:'all' retrieval by inferred section_type ([1716acb](https://github.com/betcocorp/bex2.0/commit/1716acb1dd3c853b4a3ce24a9524494907900330))
* **b0-284-hotfix:** restore chunk_sds_document_text TABLE signature ([b0926d6](https://github.com/betcocorp/bex2.0/commit/b0926d6d56f841692ff6d46c2a082d501b013f28))
* **B0-462:** pin pnpm 11 for the release workflow ([bd61dd9](https://github.com/betcocorp/bex2.0/commit/bd61dd96b4b1f00e116f19dde8c6d505aef72d76))
* **database:** add RLS policies to security-less tables & document view security [B0-284, B0-285] ([cb2d432](https://github.com/betcocorp/bex2.0/commit/cb2d432e9997e9a411393f5ef0aa62002ab71c27))
* **efficacy:** make structured efficacy answers work end-to-end ([3425a92](https://github.com/betcocorp/bex2.0/commit/3425a9243fc4ea105c4d703d7d3cf6433009ed32))
* for duplicate key ([748681b](https://github.com/betcocorp/bex2.0/commit/748681b6e2cdda5c523adf9b5c84a3dc80a20249))
* keep the service-token path open on /api/bex/workflow-runs/[id] ([1565177](https://github.com/betcocorp/bex2.0/commit/1565177a3134469d9e044a483524417d4b945c1b))
* **knowledge:** fall back to generic AWS read keys for retool-360 (B0-187) ([080f893](https://github.com/betcocorp/bex2.0/commit/080f89333beb18e1116562c10894abec81a38d33))
* **knowledge:** report ingested status from real chunk counts (B0-188) ([0988352](https://github.com/betcocorp/bex2.0/commit/098835212543c8b434580a02b446d7b8da2a0d6d))
* **migrations:** drop all function overloads before recreate [B0-284] ([e0768a9](https://github.com/betcocorp/bex2.0/commit/e0768a98e5474514704d6bb81dd44536c31adf9f))
* **migrations:** wrap bare RAISE in DO block [B0-284] ([dffc690](https://github.com/betcocorp/bex2.0/commit/dffc690d05164a37187a501d5865159bbfabd08f))
* **rag:** add filter_product_key to match_corpus_chunks(_hybrid) [B0-250 correction] ([3478014](https://github.com/betcocorp/bex2.0/commit/3478014d2258af8ea3afd7cb4f0f12a9d832cb6d))
* **rag:** correct overload drops for match_product_chunks functions [B0-281] ([a6c688e](https://github.com/betcocorp/bex2.0/commit/a6c688e3fefa299f9b0f52d4d1aa376ffddb482b))
* **rag:** disambiguate dilution_code='0' sentinel into RTU vs missing [B0-265] ([72a5e2d](https://github.com/betcocorp/bex2.0/commit/72a5e2dc1d1eb34746f8f06e14257c55ac3c1569))
* **rag:** disambiguate match_product_chunks_hybrid overload (42725) ([00ef5e6](https://github.com/betcocorp/bex2.0/commit/00ef5e685358f0bbaa068a7c957973d7cacc3260))
* **rag:** drop match_product_chunks overloads before audit [B0-281] ([8fab804](https://github.com/betcocorp/bex2.0/commit/8fab8041b583f69d94281d877ffbf5e54fea5937))
* **rag:** raise statement_timeout on hybrid match RPCs (B0-217) ([df0f156](https://github.com/betcocorp/bex2.0/commit/df0f15654582f74975137dd5fa6bcb563c44c2d3))
* **rag:** stop empty heading-only knowledge chunks from being embedded ([7059665](https://github.com/betcocorp/bex2.0/commit/70596659414360ad7dd410aabc8afa5a461cc3fb))
* **rec:** don't let a validator-revision refusal overwrite a good answer ([fbf644d](https://github.com/betcocorp/bex2.0/commit/fbf644de79c99cdbeeaac989afe84453049b753c))
* **rec:** ground competitor by chemistry + search by capability on cross-ref miss ([659ec92](https://github.com/betcocorp/bex2.0/commit/659ec929d8d49ed8998c36b37edbe5adcb5fb519)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333) [#1](https://github.com/betcocorp/bex2.0/issues/1)
* **rec:** stop forcing the validator on the recommendations route (it was nuking answers) ([f4a6d3e](https://github.com/betcocorp/bex2.0/commit/f4a6d3e367789713581d64ba3597aa02f753b234))
* **rec:** stop stapling a comparable-product headline onto a decline; force validator on rec route ([475d062](https://github.com/betcocorp/bex2.0/commit/475d0623f52d6b52551816a71537860e526fcaa3))
* **rec:** validator must not reject/overwrite a cross-reference recommendation ([3b6c197](https://github.com/betcocorp/bex2.0/commit/3b6c197f5a98358d604543d8fa45e25802d49f3d))
* **tests,rag:** grader decline detection, per-run model, hybrid + knowledge/label scopes ([5c44d6e](https://github.com/betcocorp/bex2.0/commit/5c44d6e07b8366bf1ab9863c1c0c5f793ba8cde2))
* un-ignore src/supabase so new migrations are actually tracked ([8d97504](https://github.com/betcocorp/bex2.0/commit/8d97504f7461b26a105debbd642f00bef957ffb2))


### Features

* add initial app code ([9d5bfa1](https://github.com/betcocorp/bex2.0/commit/9d5bfa1c303462d9face65303fc5029607f08ecf))
* added api test for calling web search tool using new token system ([a5fde6c](https://github.com/betcocorp/bex2.0/commit/a5fde6c946200c1b46fdb09f2757ad434b23a4f9))
* added mew chart ([4718a85](https://github.com/betcocorp/bex2.0/commit/4718a850befbd77c7e05d55595b053f5041c82b1))
* added more shadcn components ([ba27c26](https://github.com/betcocorp/bex2.0/commit/ba27c26b43620ecf8498495490750aca939c0273))
* adding auth ([45e1e5d](https://github.com/betcocorp/bex2.0/commit/45e1e5d466d71ce070fbe4836929ceed416c5ded))
* adding failed queue ([4b627f6](https://github.com/betcocorp/bex2.0/commit/4b627f6a6c0913bf082ca5b2151a87da647931f9))
* adding initial routing and orchestration ([766ae4c](https://github.com/betcocorp/bex2.0/commit/766ae4cde2f9d90a6668f31a52c9c6864287d3fb))
* adding more code to customize logic and functionality ([fa96e4c](https://github.com/betcocorp/bex2.0/commit/fa96e4c9aa8961dcbf1d738e2272340a78809b9f))
* adding more reporting and observability to the search ([29d7374](https://github.com/betcocorp/bex2.0/commit/29d7374fdf8dc6bb47f2c3d70c6d2cbad7a4af16))
* adding more reporting fine tuning. Adding other funcctionality to support workflow along with additional reporting ([b5b24fe](https://github.com/betcocorp/bex2.0/commit/b5b24fe944f92c331416d83931af346b3a07dbd7))
* adding more ui and refining views further ([2fff2b5](https://github.com/betcocorp/bex2.0/commit/2fff2b5779b6866d1ee39ff6a07b5678fb345552))
* adding sentry ([e2a0030](https://github.com/betcocorp/bex2.0/commit/e2a00309f2eeecf52e96efcd773afd7a9ef58b63))
* adding variable similarity threshold to search ([8a15332](https://github.com/betcocorp/bex2.0/commit/8a1533206649ffab7b6c035033fc9a214d95026a))
* **admin:** add Web search card to the /admin/tools landing page ([421361e](https://github.com/betcocorp/bex2.0/commit/421361e86ecdf18660210d366d4495f56427a8d4))
* **admin:** cached web-search results table in /admin/tools/web-search (B0-109) ([adb321d](https://github.com/betcocorp/bex2.0/commit/adb321d92d66d9881abece931e6494834e2f297a))
* **admin:** Orphan Monitor + product-line backfill migration [B0-267] ([d7b193d](https://github.com/betcocorp/bex2.0/commit/d7b193d5eb176fce0a2c78bcb1dfa4989975af92))
* **admin:** show web-search cache duration in Cached results subtext ([9b3f8e7](https://github.com/betcocorp/bex2.0/commit/9b3f8e7e5833d547474147ca2f03ea74f3a62636))
* **api-security:** admin projects list + create wizard (B0-116) ([4aff4d2](https://github.com/betcocorp/bex2.0/commit/4aff4d2c784df6404a2503a56ced6237e10a782e))
* **api-security:** API analytics dashboard (B0-120) ([7a88b13](https://github.com/betcocorp/bex2.0/commit/7a88b137aefb5f3200bdfb3aaffaa86b95b5aee4))
* **api-security:** app detail — tokens, rotation, kill switch, rate limit (B0-118) ([6227e1b](https://github.com/betcocorp/bex2.0/commit/6227e1bfd053c9965d5d58c903540308b71ab575))
* **api-security:** enforce per-client token on all /api/v1/* + delete legacy auth (B0-115) ([48cdf14](https://github.com/betcocorp/bex2.0/commit/48cdf14e78fca6553f8f6a7b0b347e5ed53af651))
* **api-security:** per-app rate limiting (429 + Retry-After) (B0-119) ([31fe4c3](https://github.com/betcocorp/bex2.0/commit/31fe4c386f25b1dc11bd5641c3ea45ff8a5fd08b))
* **api-security:** per-request logging + last-used tracking for /api/v1/* (B0-117) ([4e1d942](https://github.com/betcocorp/bex2.0/commit/4e1d942e0c3a80af868ede76edecf1e100a58762))
* **api-security:** project detail — apps, add app, kill switch (B0-130) ([9893c31](https://github.com/betcocorp/bex2.0/commit/9893c31be3095527d748f38af35db2671920ebd8))
* **api-security:** require NextAuth session on all /api/bex/* routes (B0-114) ([c1692d4](https://github.com/betcocorp/bex2.0/commit/c1692d4b4a61c6d141306918c846e59efe3ecc84))
* **api-security:** thread LLM token usage into request log (B0-117) ([5d1fb29](https://github.com/betcocorp/bex2.0/commit/5d1fb293220d2dc41a860b6f6f253d77bc7fa1ac))
* **api:** add /api/v1/tools registry + wire web-search into withApiV1 [B0-241/B0-242] ([73a8236](https://github.com/betcocorp/bex2.0/commit/73a8236db24b93bb25441a8605f219da6de0be26))
* **api:** expose web search as a client-authenticated v1 tool ([789df5c](https://github.com/betcocorp/bex2.0/commit/789df5c5461503a9cace9c9802b7be382407b6b7))
* B0-183 deterministic web-search fallback on cross-reference miss ([ee4b879](https://github.com/betcocorp/bex2.0/commit/ee4b879dd964dbc528b94f05792b76dc65de17fe))
* **B0-318,B0-319,B0-320,B0-321:** capture and chart time-to-first-token for test runs ([c3bfb16](https://github.com/betcocorp/bex2.0/commit/c3bfb16f17591d3ffaf1dbe00c3e629ef6a01489))
* **B0-349:** persist pre-validator draft answer on every workflow run ([d7f557e](https://github.com/betcocorp/bex2.0/commit/d7f557e38967a8e9828f0c1f5a34aded3b62959f))
* **B0-398:** add prompt-version chips to run header, runs list, and item rows ([7f7e47e](https://github.com/betcocorp/bex2.0/commit/7f7e47e139198fc8f63cfead2e609f04a333fbbf))
* **B0-399:** distinguish four run-trace empty states, centralize search-run extractors ([210f1e5](https://github.com/betcocorp/bex2.0/commit/210f1e531479b718c7435d4edfc0a3638cebb3ce))
* B0-448 conversation source column, bex.chat.view-all, test-run backfill ([932b4bd](https://github.com/betcocorp/bex2.0/commit/932b4bd8294ce062b7d884a1ecec871dbebeb8b6))
* **B0-462:** add semantic-release versioning CI for main/staging/dev ([38841f0](https://github.com/betcocorp/bex2.0/commit/38841f09bf234bbca838b8760726a476f353f045))
* **B0-462:** permissions and minor styling ([80f715f](https://github.com/betcocorp/bex2.0/commit/80f715f0791504867ff48d72a8dd34631188f586))
* **b0-95:** recommendation review & verification queue admin UI ([5c9bdd8](https://github.com/betcocorp/bex2.0/commit/5c9bdd8d580e926177af57e37887c8f2de3af235))
* **b0-96:** promote verified recommendations into fast-path xref + metrics ([4717094](https://github.com/betcocorp/bex2.0/commit/4717094a75acc2500f4e1045fc884bae4f35fa18))
* **b0-97:** threshold calibration tooling + document the real ground-truth gap ([b7eacfc](https://github.com/betcocorp/bex2.0/commit/b7eacfc1d5aaf7428828be46c8fc4c68c6d252c1))
* BO-114 ([e602c21](https://github.com/betcocorp/bex2.0/commit/e602c215f482e3b9e9fd9dd26df3c5be9346c340))
* **BO-304:** Efficacy ingestion ui reworked the ui to make more sense ([2ad40ea](https://github.com/betcocorp/bex2.0/commit/2ad40ead07423706ab800725abb9d890a7d395ab))
* BO-99 ([49c93c0](https://github.com/betcocorp/bex2.0/commit/49c93c07600db5cce3f2e3fd72a02ba0eb336598))
* **category:** admin curation UI for product→category links (B0-36) ([181e08a](https://github.com/betcocorp/bex2.0/commit/181e08a244bd6bcb1369ce4f4f08dfc58892b7b4))
* **category:** authoritative product↔category linker from betco.com scrape (B0-34) ([ba2f7fa](https://github.com/betcocorp/bex2.0/commit/ba2f7fa7dd0e961cae7e9abf4051241df633c886))
* **category:** category resolver — query -> taxonomy node + confidence (B0-27) ([809f107](https://github.com/betcocorp/bex2.0/commit/809f10763f3e1a0accb0c584e3a45043f62cc227))
* **category:** category-first router + agent tool + routing telemetry (B0-29/B0-30/B0-31) ([8c80b37](https://github.com/betcocorp/bex2.0/commit/8c80b37f22a151bec264543bc0121acc9d85ac12))
* **category:** continuous delta sync of product→category links (B0-37) ([40837d9](https://github.com/betcocorp/bex2.0/commit/40837d911642e6cd817da1b0c400f2b0964654e9))
* **category:** cross-validation report vs legacy + live site (B0-38) ([8ee2e98](https://github.com/betcocorp/bex2.0/commit/8ee2e989811b56c38b8ecf30f577a653a9e14acb))
* **category:** DB-backed taxonomy retrieval — query -> node -> products (B0-28, B0-33/B0-34 wiring) ([d1b753a](https://github.com/betcocorp/bex2.0/commit/d1b753aafc16b2d6a13675f7bd0f06f265cf4fd8))
* **category:** LLM classifier for unlinked/low-confidence prod-lines (B0-35) ([5621f68](https://github.com/betcocorp/bex2.0/commit/5621f68aca5f7233d8a51d6616bb64c87d18ce49))
* **category:** seed exact betco.com taxonomy + segregate by source (B0-33) ([9ea119d](https://github.com/betcocorp/bex2.0/commit/9ea119dc38a80ba850559a243255355404413163))
* chore cleaning up code ([bfdc4b1](https://github.com/betcocorp/bex2.0/commit/bfdc4b1e4cac10e167d1d082df161b0b16126e83))
* cleaning up ui ([856ba40](https://github.com/betcocorp/bex2.0/commit/856ba40b39c36d2260b2a7346e87eccf635e767b))
* consolidated some ui, abstracted utilities, abstracted agent definition for sanity ([1c3071e](https://github.com/betcocorp/bex2.0/commit/1c3071e67409096b701ebdc562600c23f9557b1c))
* consolidated the two cross reference pages into one with tabs ([9e53980](https://github.com/betcocorp/bex2.0/commit/9e5398069f1daef61ca5125f0e73d38b25a39f0a))
* continuing to refine context and document corpus structuring ([eee4555](https://github.com/betcocorp/bex2.0/commit/eee45559b013b851ccb23baab81d6e15b0e70eed))
* converted all code to utilize 3072 embedding over 1536 ([ea3cf11](https://github.com/betcocorp/bex2.0/commit/ea3cf11998077d3b5cc233e8ed445516f53758c7))
* converting embeddings to use 3000+ dimensions ([afc7dd2](https://github.com/betcocorp/bex2.0/commit/afc7dd2274e3f5885ef41236f5b009127aa26afa))
* download timeline json, fix corpus inex, minor ui changes ([4f180bd](https://github.com/betcocorp/bex2.0/commit/4f180bda71d8c23b22ce1d74c3a85978b8fb1803))
* **efficacy/labels:** generalize ingestion pipeline, add chunking RPC, schema, retrieval enhancements [B0-227-238, B0-256-283] ([47ab061](https://github.com/betcocorp/bex2.0/commit/47ab0619d45df00c8f2b057048ae2f1f4154c645))
* **efficacy/tools:** implement deterministic dilution lookup with RAG database integration [B0-288] ([67d23b5](https://github.com/betcocorp/bex2.0/commit/67d23b5e83c17986ac0dc3146feb3e05d87f35f7))
* **efficacy:** cross-check and enrich the 70 converted markdown files [B0-224] ([9e40736](https://github.com/betcocorp/bex2.0/commit/9e40736c56389f996aae43921e574f86a4309d53))
* **efficacy:** new document_kind='efficacy' RAG pipeline, crosswalk, citation [B0-227..238] ([3473f11](https://github.com/betcocorp/bex2.0/commit/3473f1174cf02568073e0bd1c378aa6756a6e12b))
* **efficacy:** parse Master Efficacy Version Data into a structured table [B0-223] ([2cd8db9](https://github.com/betcocorp/bex2.0/commit/2cd8db9b4ab741e6c24c545f26e5b5ea7ad428e3))
* enhanced query tuning ([0bb87ca](https://github.com/betcocorp/bex2.0/commit/0bb87cad0560a96c14215866152d6bf06a558c4b))
* enriching data and updating RAG system ([59f118f](https://github.com/betcocorp/bex2.0/commit/59f118f15761626b479a5a8f0c9cda3c89dbe244))
* expand eval refusal detection and add product category tools ([c6724f8](https://github.com/betcocorp/bex2.0/commit/c6724f80772ac7ab8143d0e28ca9f919172f3686))
* expanding the rag search results to be include more inclusive data rather than being fragmented ([53b5050](https://github.com/betcocorp/bex2.0/commit/53b50501d708e16dbf4b5b2f2916bcda9756c361))
* ingesting more efficacy docs, fixing bugs from migration and resolving new efficacy mappings ([2178dd9](https://github.com/betcocorp/bex2.0/commit/2178dd9146f4c709f511202bfdf11ad0f8c5c5ff))
* ingestion of label data ([36a73e4](https://github.com/betcocorp/bex2.0/commit/36a73e443778b49984791ad3aeb9d381eee4602a))
* knowledge base ([0012449](https://github.com/betcocorp/bex2.0/commit/0012449ac739d93e366fc89661517b69e07fc438))
* **knowledge:** admin ingest panel for v1 markdown corpus (B0-187/188/189/190) ([4509adb](https://github.com/betcocorp/bex2.0/commit/4509adb56a9033658bc69741c476c0260dfdff79))
* **knowledge:** markdown-ingest foundation — S3 read, discovery, chunker ([4ffc172](https://github.com/betcocorp/bex2.0/commit/4ffc1722800ad55cfc21eb0af54481b1aac101a4))
* **labels:** validator guardrails, exact lookup tool, citations, discontinued filter [B0-257] ([25a1559](https://github.com/betcocorp/bex2.0/commit/25a155998bc0d7277abebad52743dbb9da704d96))
* migrating the remaining items to vercel ([634e9d3](https://github.com/betcocorp/bex2.0/commit/634e9d33777b88181ee06357e74e5ad661fa29df))
* migration and pipeline remapping ([e283757](https://github.com/betcocorp/bex2.0/commit/e2837578dd80ca7331cc15066a559b7c1feef455))
* minor updates for test runner ui additions ([778c175](https://github.com/betcocorp/bex2.0/commit/778c175d0041256ff74177360fdf043401f667ff))
* **orphans:** view full underlying record from the orphan queue ([d819c0e](https://github.com/betcocorp/bex2.0/commit/d819c0ec62234271c7e5efa244abc676c30e6b0e))
* performance enhancements ([7b5e06d](https://github.com/betcocorp/bex2.0/commit/7b5e06d8bcd345cab0bf105fac0e7c4b0787bbb0))
* persist anlysis of runs to db ([49c3e94](https://github.com/betcocorp/bex2.0/commit/49c3e9412c09a3e43e69c585f2dcd4f9a9498467))
* **rag/products/efficacy:** complete B0-279/281/284/286/287/289 work ([f8c67ef](https://github.com/betcocorp/bex2.0/commit/f8c67ef27a2545b6afa5fce8e2e57bc44c4aa7b2))
* **rag:** activate filter_product_key in retrieval query resolver [B0-250] ([b857e9b](https://github.com/betcocorp/bex2.0/commit/b857e9b9d2294f9a43f328fcbb0b660cff5334b6))
* **rag:** backfill active products into rag.entity as product-tier entities [B0-246] ([572ab24](https://github.com/betcocorp/bex2.0/commit/572ab244966b7b2dd90e47fb77087ae95beecefd))
* **rag:** classify product_application from category taxonomy [B0-263] ([e6735e5](https://github.com/betcocorp/bex2.0/commit/e6735e5b9e8037b8199603f826ce5b308dc9df7e))
* **rag:** enable cross-encoder reranking on product-support retrieval path [B0-280] ([8a09582](https://github.com/betcocorp/bex2.0/commit/8a095821e01a22b51f983ca26cedb67c7f2f9a72))
* **rag:** extract dilution values from directions text for 34 lines [B0-264] ([6da953e](https://github.com/betcocorp/bex2.0/commit/6da953e3ccb6c0d881c72ddcc5fe4cbd7726f4d8))
* **rag:** link active product entities to their product-line parents [B0-247] ([717c698](https://github.com/betcocorp/bex2.0/commit/717c69864a90f61ed656dae40f5b15d4bf909736))
* **rag:** link unambiguous label documents to active product entities [B0-249] ([bc809d1](https://github.com/betcocorp/bex2.0/commit/bc809d135ceee3ae71bb1a56bab87a9d0e05a848))
* **rag:** seed SKU/InvtID aliases for active products [B0-248] ([95fb31c](https://github.com/betcocorp/bex2.0/commit/95fb31c8ac61450c7a3b54ed4ac9097819b6e6bc))
* **rag:** tune HNSW ef_search + candidate pools; lock down maintenance RPC grants & search_path [B0-278/282/283] ([abeeb80](https://github.com/betcocorp/bex2.0/commit/abeeb80f832cd28b8fc118b50b6da564801eaeaf))
* rearranged ingestion ui to make more sense in additional ingestion pages and removed working docs from claude ([fc860f1](https://github.com/betcocorp/bex2.0/commit/fc860f1c94c2431334ad641e690773b1af529ab8))
* **rec-3:** curated cross-reference override — Spartan BNC-15 → Betco Triforce (B0-46/B0-76) ([6d53017](https://github.com/betcocorp/bex2.0/commit/6d53017dee0363d49cd1fde7d13f14de7e95a6c7)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333)
* **rec:** competitive analysis + up to 2 alternatives for a curated recommendation ([6ce90bd](https://github.com/betcocorp/bex2.0/commit/6ce90bd68ee3a74be5ea5e287f7b25ff7753d2b2))
* **rec:** deterministic cross-reference override safety-net (make Triforce land) ([42ca9fe](https://github.com/betcocorp/bex2.0/commit/42ca9fe89f3a130894ed8cb040dae742032b2bbd))
* Recommendations SME agent + competitor cross-reference engine (B0-43/44/47/49/50/51) ([02af888](https://github.com/betcocorp/bex2.0/commit/02af8884d7db21ce8796936f77b9c76d35ec8497)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333)
* **recommendations:** confidence scoring + configurable threshold gate (B0-88) ([fa5b0d1](https://github.com/betcocorp/bex2.0/commit/fa5b0d1a5c95c86556a28b6f2239334c4c6c5e65))
* **recommendations:** cross-reference recommendation prompt template + output schema (B0-90) ([d1a11fa](https://github.com/betcocorp/bex2.0/commit/d1a11fa568637b300b6bf54bf9de5e5f909ba061))
* **recommendations:** guardrails for the web-grounded recommendation (B0-91) ([1f82a40](https://github.com/betcocorp/bex2.0/commit/1f82a40e5c3b447876c3b17b4f44e146b98a2968))
* **recommendations:** LLM competitor-spec enrichment on the heuristic extractor (B0-86) ([9ae36e5](https://github.com/betcocorp/bex2.0/commit/9ae36e576e35d42b702321a49e4af82f3acb1fc3))
* **recommendations:** persist every recommendation (answered + declined) (B0-89) ([87bf45d](https://github.com/betcocorp/bex2.0/commit/87bf45dcb634f37fda82dca7c4e2423c58f196c7))
* **recommendations:** rag cross-reference recommendation tables (B0-82) ([e46f57a](https://github.com/betcocorp/bex2.0/commit/e46f57a0722d3f1a893c0c98271696ac86841be6))
* **recommendations:** recommendation API endpoint + tester UI (B0-94) ([762c1e3](https://github.com/betcocorp/bex2.0/commit/762c1e3baec875928af21c3da9601b31c43b9328))
* **recommendations:** recommendCrossReference() orchestrator, legacy-first + web fallback (B0-85) ([d812f9f](https://github.com/betcocorp/bex2.0/commit/d812f9fedd61cb6e694cf19bdf26ff3f20d01eac))
* **recommendations:** retrieve N Betco candidates from the enriched spec (B0-87) ([09778ce](https://github.com/betcocorp/bex2.0/commit/09778ce9e761d7a76efe52601c50b3749359edd4))
* **recommendations:** web-search cost/domain/rate guardrails (B0-92) ([ebaf14e](https://github.com/betcocorp/bex2.0/commit/ebaf14ebd989b141e57591a49a5b80b8b41be677))
* **recommendations:** wire recommend_cross_reference agent tool into the workflow (B0-93) ([217db0b](https://github.com/betcocorp/bex2.0/commit/217db0b42fe4e60b6587b81bd84ae37ad6afe90f))
* **recommendations:** Zod contracts + repository for cross-reference recommendations (B0-83) ([543958d](https://github.com/betcocorp/bex2.0/commit/543958df135300873d2d722826b704a2ea0468b4))
* reconciling new data from 1.0 ([8203229](https://github.com/betcocorp/bex2.0/commit/8203229d5a37677a6cc1352751524554847024f9))
* restructuring chunks for embedding ([9d847d9](https://github.com/betcocorp/bex2.0/commit/9d847d9967dbc260b66e443026422d0f2c0c4b6b))
* **retrieval:** fetch structured product facts + attach to query result (B0-195) ([07bfa7c](https://github.com/betcocorp/bex2.0/commit/07bfa7c645a78d8932b1005c43fc7ed72bf5cd1b))
* **retrieval:** intent-driven curation knobs (B0-201) ([d7c5493](https://github.com/betcocorp/bex2.0/commit/d7c5493937e409fc7c17a5a167384b6f8aa34c28))
* **retrieval:** near-duplicate suppression across sources [B0-257] ([9fa2cfc](https://github.com/betcocorp/bex2.0/commit/9fa2cfc1fc8c974ba65fd224a1df375352c6c158))
* **retrieval:** product alias table resolution (B0-200) ([b3a7b7f](https://github.com/betcocorp/bex2.0/commit/b3a7b7f8041cbdfe85f401820a7ea7dd90bc1112))
* **retrieval:** surface knowledge chunks in curated results (B0-191) ([e162eb0](https://github.com/betcocorp/bex2.0/commit/e162eb0754c671a78087657003cd9d839cbe2e5e))
* **sds:** scope SDS corpus discovery to policy + content-based language check [B0-243] ([83b3636](https://github.com/betcocorp/bex2.0/commit/83b36368b78d12edcdafa6a6581ecf7716ba30af))
* starting api security work ([ab270e4](https://github.com/betcocorp/bex2.0/commit/ab270e4089c875bba5c0be854e95bf83a59b7a9a))
* test runner suite ([fb517d5](https://github.com/betcocorp/bex2.0/commit/fb517d5b2d6b60b3e1bc631487686bcd9b997fb9))
* **tools:** get_efficacy_data fact-only tool + route dilution/kill-claim intents (B0-197) ([894e33b](https://github.com/betcocorp/bex2.0/commit/894e33b0d1f4f005992cf74374f32b439bba5693))
* **tools:** ground answers on structured facts (B0-196) ([3e3a9a3](https://github.com/betcocorp/bex2.0/commit/3e3a9a31ce930403c8f8c67537b729d7ae97f315))
* tuning the search to optimize both for product data and sds ([6c5d4b5](https://github.com/betcocorp/bex2.0/commit/6c5d4b52678fca96f47f4e9d679e961df0d2d51b))
* tweaking workflows and updating ui responses ([da92099](https://github.com/betcocorp/bex2.0/commit/da92099391273810cbf7d1d4cbed0ffffff9f646))
* ui feature enhancements, new tool product cross reference tool ([f79705f](https://github.com/betcocorp/bex2.0/commit/f79705f87c3e628abd1ce93f2b0332582140c0dc))
* updating code based on docs and specifications already developed ([5b5dcda](https://github.com/betcocorp/bex2.0/commit/5b5dcdae1e04e47a073bf765b16aa81d0ccb29bc))
* updating data, add prompt, remove ([4af379d](https://github.com/betcocorp/bex2.0/commit/4af379db6c8b7f79912e9f00c3de62bb1f495339))
* vercel migration minor ui changes ([e35820a](https://github.com/betcocorp/bex2.0/commit/e35820ad0a6b6bd844bfa17d70644459495af21e))
* web search caching + competitor-spec extraction (B0-55, B0-54) ([28d582b](https://github.com/betcocorp/bex2.0/commit/28d582b2bb4b5bcafa0058573ec5e05eecdad73e))
* web search capability + admin test harness (B0-70) ([485c3d0](https://github.com/betcocorp/bex2.0/commit/485c3d00c4be7e81ee4cc0da45f623d88e0e69ad))
* **websearch:** durable DB-backed response cache (memory -> DB -> provider) ([1a0770b](https://github.com/betcocorp/bex2.0/commit/1a0770b5c15950817897e517fcfa93608ea8d0d6))
* **websearch:** external citation surface in agent output (WEB-6) ([8b80ad3](https://github.com/betcocorp/bex2.0/commit/8b80ad3ac8e190705b01067dae5ef398db90ae12))
* **websearch:** source-trust policy (WEB-2) + guardrails/cost controls (WEB-5) ([7b64c95](https://github.com/betcocorp/bex2.0/commit/7b64c95ce2783bd4162b0d69f0e1d50d82b163cf))
* working on data migration and initial vector embeddings ([59db37e](https://github.com/betcocorp/bex2.0/commit/59db37eed541b4bc06688e8b36a3b95ec21af2b2))
* working on first implementation of sub agents ([5c2fb3d](https://github.com/betcocorp/bex2.0/commit/5c2fb3db56f75587945355439982617149cf0300))

# 1.0.0 (2026-08-13)


### Bug Fixes

* **api-security:** require NextAuth session on /api/admin/tests/* routes ([52734d0](https://github.com/betcocorp/bex2.0/commit/52734d005712406a008c635e63d509dd58a67870))
* **b0-13:** surface chunk ids for retrieval auditing; investigate missed virus claims ([79d90d4](https://github.com/betcocorp/bex2.0/commit/79d90d490f2984406da60039fe23b344b6cb85b5))
* **b0-244:** undefined `KnowledgeChunk` type → `MarkdownChunk` ([27f60b2](https://github.com/betcocorp/bex2.0/commit/27f60b2cadf239d56301adb5eb55830e93cfffb7))
* **b0-272:** prose fallback for efficacy questions + tokenized product-name resolver ([534a9ad](https://github.com/betcocorp/bex2.0/commit/534a9ad59b53dc5b719875fc21939564da49b863))
* **b0-272:** stop hard-filtering scope:'all' retrieval by inferred section_type ([1716acb](https://github.com/betcocorp/bex2.0/commit/1716acb1dd3c853b4a3ce24a9524494907900330))
* **b0-284-hotfix:** restore chunk_sds_document_text TABLE signature ([b0926d6](https://github.com/betcocorp/bex2.0/commit/b0926d6d56f841692ff6d46c2a082d501b013f28))
* **B0-462:** pin pnpm 11 for the release workflow ([53728cd](https://github.com/betcocorp/bex2.0/commit/53728cdbe66177aac56d3fd96689515b0334ff6a))
* **database:** add RLS policies to security-less tables & document view security [B0-284, B0-285] ([cb2d432](https://github.com/betcocorp/bex2.0/commit/cb2d432e9997e9a411393f5ef0aa62002ab71c27))
* **efficacy:** make structured efficacy answers work end-to-end ([3425a92](https://github.com/betcocorp/bex2.0/commit/3425a9243fc4ea105c4d703d7d3cf6433009ed32))
* for duplicate key ([748681b](https://github.com/betcocorp/bex2.0/commit/748681b6e2cdda5c523adf9b5c84a3dc80a20249))
* keep the service-token path open on /api/bex/workflow-runs/[id] ([1565177](https://github.com/betcocorp/bex2.0/commit/1565177a3134469d9e044a483524417d4b945c1b))
* **knowledge:** fall back to generic AWS read keys for retool-360 (B0-187) ([080f893](https://github.com/betcocorp/bex2.0/commit/080f89333beb18e1116562c10894abec81a38d33))
* **knowledge:** report ingested status from real chunk counts (B0-188) ([0988352](https://github.com/betcocorp/bex2.0/commit/098835212543c8b434580a02b446d7b8da2a0d6d))
* **migrations:** drop all function overloads before recreate [B0-284] ([e0768a9](https://github.com/betcocorp/bex2.0/commit/e0768a98e5474514704d6bb81dd44536c31adf9f))
* **migrations:** wrap bare RAISE in DO block [B0-284] ([dffc690](https://github.com/betcocorp/bex2.0/commit/dffc690d05164a37187a501d5865159bbfabd08f))
* **rag:** add filter_product_key to match_corpus_chunks(_hybrid) [B0-250 correction] ([3478014](https://github.com/betcocorp/bex2.0/commit/3478014d2258af8ea3afd7cb4f0f12a9d832cb6d))
* **rag:** correct overload drops for match_product_chunks functions [B0-281] ([a6c688e](https://github.com/betcocorp/bex2.0/commit/a6c688e3fefa299f9b0f52d4d1aa376ffddb482b))
* **rag:** disambiguate dilution_code='0' sentinel into RTU vs missing [B0-265] ([72a5e2d](https://github.com/betcocorp/bex2.0/commit/72a5e2dc1d1eb34746f8f06e14257c55ac3c1569))
* **rag:** disambiguate match_product_chunks_hybrid overload (42725) ([00ef5e6](https://github.com/betcocorp/bex2.0/commit/00ef5e685358f0bbaa068a7c957973d7cacc3260))
* **rag:** drop match_product_chunks overloads before audit [B0-281] ([8fab804](https://github.com/betcocorp/bex2.0/commit/8fab8041b583f69d94281d877ffbf5e54fea5937))
* **rag:** raise statement_timeout on hybrid match RPCs (B0-217) ([df0f156](https://github.com/betcocorp/bex2.0/commit/df0f15654582f74975137dd5fa6bcb563c44c2d3))
* **rag:** stop empty heading-only knowledge chunks from being embedded ([7059665](https://github.com/betcocorp/bex2.0/commit/70596659414360ad7dd410aabc8afa5a461cc3fb))
* **rec:** don't let a validator-revision refusal overwrite a good answer ([fbf644d](https://github.com/betcocorp/bex2.0/commit/fbf644de79c99cdbeeaac989afe84453049b753c))
* **rec:** ground competitor by chemistry + search by capability on cross-ref miss ([659ec92](https://github.com/betcocorp/bex2.0/commit/659ec929d8d49ed8998c36b37edbe5adcb5fb519)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333) [#1](https://github.com/betcocorp/bex2.0/issues/1)
* **rec:** stop forcing the validator on the recommendations route (it was nuking answers) ([f4a6d3e](https://github.com/betcocorp/bex2.0/commit/f4a6d3e367789713581d64ba3597aa02f753b234))
* **rec:** stop stapling a comparable-product headline onto a decline; force validator on rec route ([475d062](https://github.com/betcocorp/bex2.0/commit/475d0623f52d6b52551816a71537860e526fcaa3))
* **rec:** validator must not reject/overwrite a cross-reference recommendation ([3b6c197](https://github.com/betcocorp/bex2.0/commit/3b6c197f5a98358d604543d8fa45e25802d49f3d))
* **tests,rag:** grader decline detection, per-run model, hybrid + knowledge/label scopes ([5c44d6e](https://github.com/betcocorp/bex2.0/commit/5c44d6e07b8366bf1ab9863c1c0c5f793ba8cde2))
* un-ignore src/supabase so new migrations are actually tracked ([8d97504](https://github.com/betcocorp/bex2.0/commit/8d97504f7461b26a105debbd642f00bef957ffb2))


### Features

* add initial app code ([9d5bfa1](https://github.com/betcocorp/bex2.0/commit/9d5bfa1c303462d9face65303fc5029607f08ecf))
* added api test for calling web search tool using new token system ([a5fde6c](https://github.com/betcocorp/bex2.0/commit/a5fde6c946200c1b46fdb09f2757ad434b23a4f9))
* added mew chart ([4718a85](https://github.com/betcocorp/bex2.0/commit/4718a850befbd77c7e05d55595b053f5041c82b1))
* added more shadcn components ([ba27c26](https://github.com/betcocorp/bex2.0/commit/ba27c26b43620ecf8498495490750aca939c0273))
* adding auth ([45e1e5d](https://github.com/betcocorp/bex2.0/commit/45e1e5d466d71ce070fbe4836929ceed416c5ded))
* adding failed queue ([4b627f6](https://github.com/betcocorp/bex2.0/commit/4b627f6a6c0913bf082ca5b2151a87da647931f9))
* adding initial routing and orchestration ([766ae4c](https://github.com/betcocorp/bex2.0/commit/766ae4cde2f9d90a6668f31a52c9c6864287d3fb))
* adding more code to customize logic and functionality ([fa96e4c](https://github.com/betcocorp/bex2.0/commit/fa96e4c9aa8961dcbf1d738e2272340a78809b9f))
* adding more reporting and observability to the search ([29d7374](https://github.com/betcocorp/bex2.0/commit/29d7374fdf8dc6bb47f2c3d70c6d2cbad7a4af16))
* adding more reporting fine tuning. Adding other funcctionality to support workflow along with additional reporting ([b5b24fe](https://github.com/betcocorp/bex2.0/commit/b5b24fe944f92c331416d83931af346b3a07dbd7))
* adding more ui and refining views further ([2fff2b5](https://github.com/betcocorp/bex2.0/commit/2fff2b5779b6866d1ee39ff6a07b5678fb345552))
* adding sentry ([e2a0030](https://github.com/betcocorp/bex2.0/commit/e2a00309f2eeecf52e96efcd773afd7a9ef58b63))
* adding variable similarity threshold to search ([8a15332](https://github.com/betcocorp/bex2.0/commit/8a1533206649ffab7b6c035033fc9a214d95026a))
* **admin:** add Web search card to the /admin/tools landing page ([421361e](https://github.com/betcocorp/bex2.0/commit/421361e86ecdf18660210d366d4495f56427a8d4))
* **admin:** cached web-search results table in /admin/tools/web-search (B0-109) ([adb321d](https://github.com/betcocorp/bex2.0/commit/adb321d92d66d9881abece931e6494834e2f297a))
* **admin:** Orphan Monitor + product-line backfill migration [B0-267] ([d7b193d](https://github.com/betcocorp/bex2.0/commit/d7b193d5eb176fce0a2c78bcb1dfa4989975af92))
* **admin:** show web-search cache duration in Cached results subtext ([9b3f8e7](https://github.com/betcocorp/bex2.0/commit/9b3f8e7e5833d547474147ca2f03ea74f3a62636))
* **api-security:** admin projects list + create wizard (B0-116) ([4aff4d2](https://github.com/betcocorp/bex2.0/commit/4aff4d2c784df6404a2503a56ced6237e10a782e))
* **api-security:** API analytics dashboard (B0-120) ([7a88b13](https://github.com/betcocorp/bex2.0/commit/7a88b137aefb5f3200bdfb3aaffaa86b95b5aee4))
* **api-security:** app detail — tokens, rotation, kill switch, rate limit (B0-118) ([6227e1b](https://github.com/betcocorp/bex2.0/commit/6227e1bfd053c9965d5d58c903540308b71ab575))
* **api-security:** enforce per-client token on all /api/v1/* + delete legacy auth (B0-115) ([48cdf14](https://github.com/betcocorp/bex2.0/commit/48cdf14e78fca6553f8f6a7b0b347e5ed53af651))
* **api-security:** per-app rate limiting (429 + Retry-After) (B0-119) ([31fe4c3](https://github.com/betcocorp/bex2.0/commit/31fe4c386f25b1dc11bd5641c3ea45ff8a5fd08b))
* **api-security:** per-request logging + last-used tracking for /api/v1/* (B0-117) ([4e1d942](https://github.com/betcocorp/bex2.0/commit/4e1d942e0c3a80af868ede76edecf1e100a58762))
* **api-security:** project detail — apps, add app, kill switch (B0-130) ([9893c31](https://github.com/betcocorp/bex2.0/commit/9893c31be3095527d748f38af35db2671920ebd8))
* **api-security:** require NextAuth session on all /api/bex/* routes (B0-114) ([c1692d4](https://github.com/betcocorp/bex2.0/commit/c1692d4b4a61c6d141306918c846e59efe3ecc84))
* **api-security:** thread LLM token usage into request log (B0-117) ([5d1fb29](https://github.com/betcocorp/bex2.0/commit/5d1fb293220d2dc41a860b6f6f253d77bc7fa1ac))
* **api:** add /api/v1/tools registry + wire web-search into withApiV1 [B0-241/B0-242] ([73a8236](https://github.com/betcocorp/bex2.0/commit/73a8236db24b93bb25441a8605f219da6de0be26))
* **api:** expose web search as a client-authenticated v1 tool ([789df5c](https://github.com/betcocorp/bex2.0/commit/789df5c5461503a9cace9c9802b7be382407b6b7))
* B0-183 deterministic web-search fallback on cross-reference miss ([ee4b879](https://github.com/betcocorp/bex2.0/commit/ee4b879dd964dbc528b94f05792b76dc65de17fe))
* **B0-318,B0-319,B0-320,B0-321:** capture and chart time-to-first-token for test runs ([c3bfb16](https://github.com/betcocorp/bex2.0/commit/c3bfb16f17591d3ffaf1dbe00c3e629ef6a01489))
* B0-448 conversation source column, bex.chat.view-all, test-run backfill ([932b4bd](https://github.com/betcocorp/bex2.0/commit/932b4bd8294ce062b7d884a1ecec871dbebeb8b6))
* **B0-462:** add semantic-release versioning CI for main/staging/dev ([38841f0](https://github.com/betcocorp/bex2.0/commit/38841f09bf234bbca838b8760726a476f353f045))
* **b0-95:** recommendation review & verification queue admin UI ([5c9bdd8](https://github.com/betcocorp/bex2.0/commit/5c9bdd8d580e926177af57e37887c8f2de3af235))
* **b0-96:** promote verified recommendations into fast-path xref + metrics ([4717094](https://github.com/betcocorp/bex2.0/commit/4717094a75acc2500f4e1045fc884bae4f35fa18))
* **b0-97:** threshold calibration tooling + document the real ground-truth gap ([b7eacfc](https://github.com/betcocorp/bex2.0/commit/b7eacfc1d5aaf7428828be46c8fc4c68c6d252c1))
* BO-114 ([e602c21](https://github.com/betcocorp/bex2.0/commit/e602c215f482e3b9e9fd9dd26df3c5be9346c340))
* **BO-304:** Efficacy ingestion ui reworked the ui to make more sense ([2ad40ea](https://github.com/betcocorp/bex2.0/commit/2ad40ead07423706ab800725abb9d890a7d395ab))
* BO-99 ([49c93c0](https://github.com/betcocorp/bex2.0/commit/49c93c07600db5cce3f2e3fd72a02ba0eb336598))
* **category:** admin curation UI for product→category links (B0-36) ([181e08a](https://github.com/betcocorp/bex2.0/commit/181e08a244bd6bcb1369ce4f4f08dfc58892b7b4))
* **category:** authoritative product↔category linker from betco.com scrape (B0-34) ([ba2f7fa](https://github.com/betcocorp/bex2.0/commit/ba2f7fa7dd0e961cae7e9abf4051241df633c886))
* **category:** category resolver — query -> taxonomy node + confidence (B0-27) ([809f107](https://github.com/betcocorp/bex2.0/commit/809f10763f3e1a0accb0c584e3a45043f62cc227))
* **category:** category-first router + agent tool + routing telemetry (B0-29/B0-30/B0-31) ([8c80b37](https://github.com/betcocorp/bex2.0/commit/8c80b37f22a151bec264543bc0121acc9d85ac12))
* **category:** continuous delta sync of product→category links (B0-37) ([40837d9](https://github.com/betcocorp/bex2.0/commit/40837d911642e6cd817da1b0c400f2b0964654e9))
* **category:** cross-validation report vs legacy + live site (B0-38) ([8ee2e98](https://github.com/betcocorp/bex2.0/commit/8ee2e989811b56c38b8ecf30f577a653a9e14acb))
* **category:** DB-backed taxonomy retrieval — query -> node -> products (B0-28, B0-33/B0-34 wiring) ([d1b753a](https://github.com/betcocorp/bex2.0/commit/d1b753aafc16b2d6a13675f7bd0f06f265cf4fd8))
* **category:** LLM classifier for unlinked/low-confidence prod-lines (B0-35) ([5621f68](https://github.com/betcocorp/bex2.0/commit/5621f68aca5f7233d8a51d6616bb64c87d18ce49))
* **category:** seed exact betco.com taxonomy + segregate by source (B0-33) ([9ea119d](https://github.com/betcocorp/bex2.0/commit/9ea119dc38a80ba850559a243255355404413163))
* chore cleaning up code ([bfdc4b1](https://github.com/betcocorp/bex2.0/commit/bfdc4b1e4cac10e167d1d082df161b0b16126e83))
* cleaning up ui ([856ba40](https://github.com/betcocorp/bex2.0/commit/856ba40b39c36d2260b2a7346e87eccf635e767b))
* consolidated some ui, abstracted utilities, abstracted agent definition for sanity ([1c3071e](https://github.com/betcocorp/bex2.0/commit/1c3071e67409096b701ebdc562600c23f9557b1c))
* consolidated the two cross reference pages into one with tabs ([9e53980](https://github.com/betcocorp/bex2.0/commit/9e5398069f1daef61ca5125f0e73d38b25a39f0a))
* continuing to refine context and document corpus structuring ([eee4555](https://github.com/betcocorp/bex2.0/commit/eee45559b013b851ccb23baab81d6e15b0e70eed))
* converted all code to utilize 3072 embedding over 1536 ([ea3cf11](https://github.com/betcocorp/bex2.0/commit/ea3cf11998077d3b5cc233e8ed445516f53758c7))
* converting embeddings to use 3000+ dimensions ([afc7dd2](https://github.com/betcocorp/bex2.0/commit/afc7dd2274e3f5885ef41236f5b009127aa26afa))
* download timeline json, fix corpus inex, minor ui changes ([4f180bd](https://github.com/betcocorp/bex2.0/commit/4f180bda71d8c23b22ce1d74c3a85978b8fb1803))
* **efficacy/labels:** generalize ingestion pipeline, add chunking RPC, schema, retrieval enhancements [B0-227-238, B0-256-283] ([47ab061](https://github.com/betcocorp/bex2.0/commit/47ab0619d45df00c8f2b057048ae2f1f4154c645))
* **efficacy/tools:** implement deterministic dilution lookup with RAG database integration [B0-288] ([67d23b5](https://github.com/betcocorp/bex2.0/commit/67d23b5e83c17986ac0dc3146feb3e05d87f35f7))
* **efficacy:** cross-check and enrich the 70 converted markdown files [B0-224] ([9e40736](https://github.com/betcocorp/bex2.0/commit/9e40736c56389f996aae43921e574f86a4309d53))
* **efficacy:** new document_kind='efficacy' RAG pipeline, crosswalk, citation [B0-227..238] ([3473f11](https://github.com/betcocorp/bex2.0/commit/3473f1174cf02568073e0bd1c378aa6756a6e12b))
* **efficacy:** parse Master Efficacy Version Data into a structured table [B0-223] ([2cd8db9](https://github.com/betcocorp/bex2.0/commit/2cd8db9b4ab741e6c24c545f26e5b5ea7ad428e3))
* enhanced query tuning ([0bb87ca](https://github.com/betcocorp/bex2.0/commit/0bb87cad0560a96c14215866152d6bf06a558c4b))
* enriching data and updating RAG system ([59f118f](https://github.com/betcocorp/bex2.0/commit/59f118f15761626b479a5a8f0c9cda3c89dbe244))
* expand eval refusal detection and add product category tools ([c6724f8](https://github.com/betcocorp/bex2.0/commit/c6724f80772ac7ab8143d0e28ca9f919172f3686))
* expanding the rag search results to be include more inclusive data rather than being fragmented ([53b5050](https://github.com/betcocorp/bex2.0/commit/53b50501d708e16dbf4b5b2f2916bcda9756c361))
* ingesting more efficacy docs, fixing bugs from migration and resolving new efficacy mappings ([2178dd9](https://github.com/betcocorp/bex2.0/commit/2178dd9146f4c709f511202bfdf11ad0f8c5c5ff))
* ingestion of label data ([36a73e4](https://github.com/betcocorp/bex2.0/commit/36a73e443778b49984791ad3aeb9d381eee4602a))
* knowledge base ([0012449](https://github.com/betcocorp/bex2.0/commit/0012449ac739d93e366fc89661517b69e07fc438))
* **knowledge:** admin ingest panel for v1 markdown corpus (B0-187/188/189/190) ([4509adb](https://github.com/betcocorp/bex2.0/commit/4509adb56a9033658bc69741c476c0260dfdff79))
* **knowledge:** markdown-ingest foundation — S3 read, discovery, chunker ([4ffc172](https://github.com/betcocorp/bex2.0/commit/4ffc1722800ad55cfc21eb0af54481b1aac101a4))
* **labels:** validator guardrails, exact lookup tool, citations, discontinued filter [B0-257] ([25a1559](https://github.com/betcocorp/bex2.0/commit/25a155998bc0d7277abebad52743dbb9da704d96))
* migrating the remaining items to vercel ([634e9d3](https://github.com/betcocorp/bex2.0/commit/634e9d33777b88181ee06357e74e5ad661fa29df))
* migration and pipeline remapping ([e283757](https://github.com/betcocorp/bex2.0/commit/e2837578dd80ca7331cc15066a559b7c1feef455))
* minor updates for test runner ui additions ([778c175](https://github.com/betcocorp/bex2.0/commit/778c175d0041256ff74177360fdf043401f667ff))
* **orphans:** view full underlying record from the orphan queue ([d819c0e](https://github.com/betcocorp/bex2.0/commit/d819c0ec62234271c7e5efa244abc676c30e6b0e))
* performance enhancements ([7b5e06d](https://github.com/betcocorp/bex2.0/commit/7b5e06d8bcd345cab0bf105fac0e7c4b0787bbb0))
* persist anlysis of runs to db ([49c3e94](https://github.com/betcocorp/bex2.0/commit/49c3e9412c09a3e43e69c585f2dcd4f9a9498467))
* **rag/products/efficacy:** complete B0-279/281/284/286/287/289 work ([f8c67ef](https://github.com/betcocorp/bex2.0/commit/f8c67ef27a2545b6afa5fce8e2e57bc44c4aa7b2))
* **rag:** activate filter_product_key in retrieval query resolver [B0-250] ([b857e9b](https://github.com/betcocorp/bex2.0/commit/b857e9b9d2294f9a43f328fcbb0b660cff5334b6))
* **rag:** backfill active products into rag.entity as product-tier entities [B0-246] ([572ab24](https://github.com/betcocorp/bex2.0/commit/572ab244966b7b2dd90e47fb77087ae95beecefd))
* **rag:** classify product_application from category taxonomy [B0-263] ([e6735e5](https://github.com/betcocorp/bex2.0/commit/e6735e5b9e8037b8199603f826ce5b308dc9df7e))
* **rag:** enable cross-encoder reranking on product-support retrieval path [B0-280] ([8a09582](https://github.com/betcocorp/bex2.0/commit/8a095821e01a22b51f983ca26cedb67c7f2f9a72))
* **rag:** extract dilution values from directions text for 34 lines [B0-264] ([6da953e](https://github.com/betcocorp/bex2.0/commit/6da953e3ccb6c0d881c72ddcc5fe4cbd7726f4d8))
* **rag:** link active product entities to their product-line parents [B0-247] ([717c698](https://github.com/betcocorp/bex2.0/commit/717c69864a90f61ed656dae40f5b15d4bf909736))
* **rag:** link unambiguous label documents to active product entities [B0-249] ([bc809d1](https://github.com/betcocorp/bex2.0/commit/bc809d135ceee3ae71bb1a56bab87a9d0e05a848))
* **rag:** seed SKU/InvtID aliases for active products [B0-248] ([95fb31c](https://github.com/betcocorp/bex2.0/commit/95fb31c8ac61450c7a3b54ed4ac9097819b6e6bc))
* **rag:** tune HNSW ef_search + candidate pools; lock down maintenance RPC grants & search_path [B0-278/282/283] ([abeeb80](https://github.com/betcocorp/bex2.0/commit/abeeb80f832cd28b8fc118b50b6da564801eaeaf))
* rearranged ingestion ui to make more sense in additional ingestion pages and removed working docs from claude ([fc860f1](https://github.com/betcocorp/bex2.0/commit/fc860f1c94c2431334ad641e690773b1af529ab8))
* **rec-3:** curated cross-reference override — Spartan BNC-15 → Betco Triforce (B0-46/B0-76) ([6d53017](https://github.com/betcocorp/bex2.0/commit/6d53017dee0363d49cd1fde7d13f14de7e95a6c7)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333)
* **rec:** competitive analysis + up to 2 alternatives for a curated recommendation ([6ce90bd](https://github.com/betcocorp/bex2.0/commit/6ce90bd68ee3a74be5ea5e287f7b25ff7753d2b2))
* **rec:** deterministic cross-reference override safety-net (make Triforce land) ([42ca9fe](https://github.com/betcocorp/bex2.0/commit/42ca9fe89f3a130894ed8cb040dae742032b2bbd))
* Recommendations SME agent + competitor cross-reference engine (B0-43/44/47/49/50/51) ([02af888](https://github.com/betcocorp/bex2.0/commit/02af8884d7db21ce8796936f77b9c76d35ec8497)), closes [#333](https://github.com/betcocorp/bex2.0/issues/333)
* **recommendations:** confidence scoring + configurable threshold gate (B0-88) ([fa5b0d1](https://github.com/betcocorp/bex2.0/commit/fa5b0d1a5c95c86556a28b6f2239334c4c6c5e65))
* **recommendations:** cross-reference recommendation prompt template + output schema (B0-90) ([d1a11fa](https://github.com/betcocorp/bex2.0/commit/d1a11fa568637b300b6bf54bf9de5e5f909ba061))
* **recommendations:** guardrails for the web-grounded recommendation (B0-91) ([1f82a40](https://github.com/betcocorp/bex2.0/commit/1f82a40e5c3b447876c3b17b4f44e146b98a2968))
* **recommendations:** LLM competitor-spec enrichment on the heuristic extractor (B0-86) ([9ae36e5](https://github.com/betcocorp/bex2.0/commit/9ae36e576e35d42b702321a49e4af82f3acb1fc3))
* **recommendations:** persist every recommendation (answered + declined) (B0-89) ([87bf45d](https://github.com/betcocorp/bex2.0/commit/87bf45dcb634f37fda82dca7c4e2423c58f196c7))
* **recommendations:** rag cross-reference recommendation tables (B0-82) ([e46f57a](https://github.com/betcocorp/bex2.0/commit/e46f57a0722d3f1a893c0c98271696ac86841be6))
* **recommendations:** recommendation API endpoint + tester UI (B0-94) ([762c1e3](https://github.com/betcocorp/bex2.0/commit/762c1e3baec875928af21c3da9601b31c43b9328))
* **recommendations:** recommendCrossReference() orchestrator, legacy-first + web fallback (B0-85) ([d812f9f](https://github.com/betcocorp/bex2.0/commit/d812f9fedd61cb6e694cf19bdf26ff3f20d01eac))
* **recommendations:** retrieve N Betco candidates from the enriched spec (B0-87) ([09778ce](https://github.com/betcocorp/bex2.0/commit/09778ce9e761d7a76efe52601c50b3749359edd4))
* **recommendations:** web-search cost/domain/rate guardrails (B0-92) ([ebaf14e](https://github.com/betcocorp/bex2.0/commit/ebaf14ebd989b141e57591a49a5b80b8b41be677))
* **recommendations:** wire recommend_cross_reference agent tool into the workflow (B0-93) ([217db0b](https://github.com/betcocorp/bex2.0/commit/217db0b42fe4e60b6587b81bd84ae37ad6afe90f))
* **recommendations:** Zod contracts + repository for cross-reference recommendations (B0-83) ([543958d](https://github.com/betcocorp/bex2.0/commit/543958df135300873d2d722826b704a2ea0468b4))
* reconciling new data from 1.0 ([8203229](https://github.com/betcocorp/bex2.0/commit/8203229d5a37677a6cc1352751524554847024f9))
* restructuring chunks for embedding ([9d847d9](https://github.com/betcocorp/bex2.0/commit/9d847d9967dbc260b66e443026422d0f2c0c4b6b))
* **retrieval:** fetch structured product facts + attach to query result (B0-195) ([07bfa7c](https://github.com/betcocorp/bex2.0/commit/07bfa7c645a78d8932b1005c43fc7ed72bf5cd1b))
* **retrieval:** intent-driven curation knobs (B0-201) ([d7c5493](https://github.com/betcocorp/bex2.0/commit/d7c5493937e409fc7c17a5a167384b6f8aa34c28))
* **retrieval:** near-duplicate suppression across sources [B0-257] ([9fa2cfc](https://github.com/betcocorp/bex2.0/commit/9fa2cfc1fc8c974ba65fd224a1df375352c6c158))
* **retrieval:** product alias table resolution (B0-200) ([b3a7b7f](https://github.com/betcocorp/bex2.0/commit/b3a7b7f8041cbdfe85f401820a7ea7dd90bc1112))
* **retrieval:** surface knowledge chunks in curated results (B0-191) ([e162eb0](https://github.com/betcocorp/bex2.0/commit/e162eb0754c671a78087657003cd9d839cbe2e5e))
* **sds:** scope SDS corpus discovery to policy + content-based language check [B0-243] ([83b3636](https://github.com/betcocorp/bex2.0/commit/83b36368b78d12edcdafa6a6581ecf7716ba30af))
* starting api security work ([ab270e4](https://github.com/betcocorp/bex2.0/commit/ab270e4089c875bba5c0be854e95bf83a59b7a9a))
* test runner suite ([fb517d5](https://github.com/betcocorp/bex2.0/commit/fb517d5b2d6b60b3e1bc631487686bcd9b997fb9))
* **tools:** get_efficacy_data fact-only tool + route dilution/kill-claim intents (B0-197) ([894e33b](https://github.com/betcocorp/bex2.0/commit/894e33b0d1f4f005992cf74374f32b439bba5693))
* **tools:** ground answers on structured facts (B0-196) ([3e3a9a3](https://github.com/betcocorp/bex2.0/commit/3e3a9a31ce930403c8f8c67537b729d7ae97f315))
* tuning the search to optimize both for product data and sds ([6c5d4b5](https://github.com/betcocorp/bex2.0/commit/6c5d4b52678fca96f47f4e9d679e961df0d2d51b))
* tweaking workflows and updating ui responses ([da92099](https://github.com/betcocorp/bex2.0/commit/da92099391273810cbf7d1d4cbed0ffffff9f646))
* ui feature enhancements, new tool product cross reference tool ([f79705f](https://github.com/betcocorp/bex2.0/commit/f79705f87c3e628abd1ce93f2b0332582140c0dc))
* updating code based on docs and specifications already developed ([5b5dcda](https://github.com/betcocorp/bex2.0/commit/5b5dcdae1e04e47a073bf765b16aa81d0ccb29bc))
* updating data, add prompt, remove ([4af379d](https://github.com/betcocorp/bex2.0/commit/4af379db6c8b7f79912e9f00c3de62bb1f495339))
* vercel migration minor ui changes ([e35820a](https://github.com/betcocorp/bex2.0/commit/e35820ad0a6b6bd844bfa17d70644459495af21e))
* web search caching + competitor-spec extraction (B0-55, B0-54) ([28d582b](https://github.com/betcocorp/bex2.0/commit/28d582b2bb4b5bcafa0058573ec5e05eecdad73e))
* web search capability + admin test harness (B0-70) ([485c3d0](https://github.com/betcocorp/bex2.0/commit/485c3d00c4be7e81ee4cc0da45f623d88e0e69ad))
* **websearch:** durable DB-backed response cache (memory -> DB -> provider) ([1a0770b](https://github.com/betcocorp/bex2.0/commit/1a0770b5c15950817897e517fcfa93608ea8d0d6))
* **websearch:** external citation surface in agent output (WEB-6) ([8b80ad3](https://github.com/betcocorp/bex2.0/commit/8b80ad3ac8e190705b01067dae5ef398db90ae12))
* **websearch:** source-trust policy (WEB-2) + guardrails/cost controls (WEB-5) ([7b64c95](https://github.com/betcocorp/bex2.0/commit/7b64c95ce2783bd4162b0d69f0e1d50d82b163cf))
* working on data migration and initial vector embeddings ([59db37e](https://github.com/betcocorp/bex2.0/commit/59db37eed541b4bc06688e8b36a3b95ec21af2b2))
* working on first implementation of sub agents ([5c2fb3d](https://github.com/betcocorp/bex2.0/commit/5c2fb3db56f75587945355439982617149cf0300))
