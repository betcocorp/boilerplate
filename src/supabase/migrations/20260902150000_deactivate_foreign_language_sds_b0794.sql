-- B0-794: remove content-French/Spanish/Italian SDS from the retrievable corpus.
--
-- WHAT THIS FIXES
-- ---------------
-- 364 SDS documents carry `language_code = 'EN'` in `rag.document` while their real
-- extracted `body_text` is Spanish, French or Italian. They sit inside the `Betco SDS/`
-- policy prefix, their `source_record.is_active` is true, and they are chunked and
-- embedded -- so Bex can retrieve one and treat it as an English safety source.
--
-- The path policy in `src/app/(authenticated)/admin/sds/policy.ts` missed them because it
-- excludes non-English by FOLDER keyword ('spanish', 'french canadian', 'mexican form sds')
-- and these files live in ordinary transfer/archive folders, distinguished only by an
-- FR / SP / MX / IT suffix on the filename stem. That module's own docstring names
-- `evaluateSdsContentLanguage` (content-based, via `franc`) as the authoritative gate;
-- this migration is the result of finally running it over every SDS body_text.
--
-- HOW THE SET WAS ESTABLISHED (content, not filename)
-- ---------------------------------------------------
-- `franc` was run over the real `body_text` of all 3,159 `document_kind = 'sds'` rows.
-- Of the 1526 that are actually retrievable (source_record.is_active = true AND at least
-- one chunk):
--   * 1162 detected English  -> untouched
--   * 205 detected Spanish  -> listed below as ES
--   * 158 detected French   -> listed below as FR
--   * 1 detected Italian  -> listed below as IT
--   * 0 inconclusive ('und') -- nothing here is a guess. Per org policy, inconclusive
--     detections are reported and left alone, never purged.
-- Every id below was individually detected from its own document body. The filename
-- suffix was only ever used to go looking; it decided nothing.
--
-- MECHANISM (follows the B0-283 / B0-243 precedent, and is reversible)
-- -------------------------------------------------------------------
-- `rag.source_record.is_active = false` is this repo's established out-of-scope SDS
-- mechanism (20260725103000_purge_out_of_scope_sds_documents_b0283.sql). Verified live
-- against the deployed schema, it is also the real retrieval gate: all four retrieval
-- RPCs -- match_corpus_chunks, match_corpus_chunks_hybrid, match_product_chunks and
-- match_product_chunks_hybrid -- require `sr.is_active = true` AND
-- `upper(d.language_code) = 'EN'`. (The `corpus_scope` column added by B0-283 no longer
-- exists in the deployed schema, so it is deliberately not used here.)
--
-- Three steps, all reversible:
--   1. is_active = false            -- drops them out of every match_* RPC immediately.
--   2. delete their document_chunk  -- this is exactly what `rag.sync_sds_chunks` already
--      does for an inactive SDS document, done here so it takes effect at once rather
--      than on the next pipeline run. It also takes their vectors out of the ANN
--      candidate pool: match_corpus_chunks and the fast branch of
--      match_corpus_chunks_hybrid draw their top-N nearest neighbours BEFORE applying the
--      is_active / language filters, so foreign-language chunks were silently consuming
--      candidate slots and diluting English recall even while never being returned.
--   3. language_code = the detected language -- corrects the wrong metadata that is the
--      ticket's actual title, and adds a second independent gate (all four RPCs require
--      language_code = 'EN'). The previous value is preserved in
--      metadata->'b0794_language_reclassification' so the change is auditable and undoable.
--
-- RECOVERABLE: the `rag.document` row, its `body_text` / `body_markdown` / `metadata` /
-- `entity_id`, the `rag.source_record` row and the S3 object are all left intact. To
-- reverse: set is_active = true, restore language_code from the metadata key above, then
-- re-run `rag.sync_sds_chunks` and the embedding pass.
-- NOT RECOVERABLE without recomputation: the deleted `rag.document_chunk` rows and their
-- `embedding_large` vectors -- both are re-derivable from the retained body_text.
--
-- IDEMPOTENT: re-running matches the same ids, finds is_active already false, no chunks
-- to delete and language_code already correct, and writes nothing new. The
-- reclassification metadata is only written once (it is not overwritten on a second run,
-- so the original 'EN' value can never be lost).

BEGIN;

CREATE TEMPORARY TABLE b0794_foreign_language_sds (
  document_id      uuid PRIMARY KEY,
  detected_locale  text NOT NULL
) ON COMMIT DROP;

-- (document_id, language detected from that document's own body_text).
-- The file path of each row is already on the row itself, in
-- rag.document.metadata->>'s3_key', so it is not duplicated here. Distribution:
--    83  Betco SDS/Chemtrec SDS files ready to transfer/Betco CCN2664 files as of 12-31-21/
--    60  Betco SDS/Chemtrec SDS files ready to transfer/Betco CCN2664 7-25-25/
--    59  Betco SDS/Chemtrec SDS files ready to transfer/Betco CCN 2664 7-7-22 Index/
--    38  Betco SDS/Archive SDS/
--    35  Betco SDS/Chemtrec SDS files ready to transfer/5.20.24/
--    32  Betco SDS/Chemtrec SDS files ready to transfer/Betco CCN2664 2-17-23/
--    29  Betco SDS/Specials/
--    12  Betco SDS/Chemtrec SDS files ready to transfer/Betco CCN 2664 11-11-22 Index/
--     5  Betco SDS/Diluted Product SDS/
--     5  Betco SDS/Diluted Product SDS/Diluted Archive/
--     3  Betco SDS/Diluted Product SDS/FastDraw Diluted SDS/
--     2  Betco SDS/Specials/Archived Specials/
--     1  Betco SDS/
INSERT INTO b0794_foreign_language_sds (document_id, detected_locale) VALUES
  ('6e4e5875-bc1c-46fa-ad22-24b7bc2f6b59', 'ES'),
  ('9e0377c1-f0c0-4070-a546-dae45a5970e1', 'ES'),
  ('19252874-c47e-42f7-bb33-26efd816d6a3', 'FR'),
  ('25b8dac1-b297-4026-ba18-c5409f10931b', 'ES'),
  ('c79e9f7e-107f-4b44-8c44-3f39821fd700', 'FR'),
  ('02060635-cfa3-4026-8b8b-fa5be26be34f', 'ES'),
  ('66ac83ea-84cc-4049-b852-08bbc535650e', 'FR'),
  ('fc76d9df-24f2-41e5-b662-d656742567ee', 'ES'),
  ('f2081390-9c7c-4c7c-a2fd-97ab81b8b5f6', 'ES'),
  ('257c3374-b001-4ba7-839f-ea467c675e7d', 'FR'),
  ('83e40d52-8e18-49ab-9cc4-60f6c2b5e55f', 'ES'),
  ('0d778c0c-eb61-4f7c-9487-31a2d9dba333', 'FR'),
  ('c9757144-f9eb-47c2-a304-4059b1ac8c3e', 'ES'),
  ('b03d9308-b4c7-4172-b59b-3c6f884b7636', 'FR'),
  ('9f48fa34-c901-46fa-86ba-6140023c3fe3', 'ES'),
  ('d75277f4-8c20-427f-ab71-258906c78187', 'FR'),
  ('ec801911-6f2e-4e33-8885-adf6b85596eb', 'ES'),
  ('3d110bcd-f1c7-440d-a0ff-6c757c0e0496', 'FR'),
  ('f5c454ac-a0d2-473b-9b0e-858dc28eba34', 'ES'),
  ('e422b357-e1c4-476e-9acd-5356dfbbbddb', 'ES'),
  ('c84272a3-1bed-4781-a401-7441cfd06d0b', 'FR'),
  ('3576a20e-d2a6-4861-9fd4-1fb8d8766d37', 'ES'),
  ('f9837f2e-675c-430d-9466-23e5f86e1554', 'FR'),
  ('31d153dc-b55f-40a9-8024-7cb5d7a16880', 'ES'),
  ('f20105d9-3877-4446-a802-71d5a3481d7d', 'FR'),
  ('2044b6d4-b1fa-4bb5-b094-a2a7ed996b5d', 'ES'),
  ('f969d48b-aa51-4601-bff3-2f2d346c7392', 'FR'),
  ('f2cb9b0c-7b48-4565-aacd-5544c65bd20d', 'ES'),
  ('1664c4a7-5148-4b67-8765-355671d32224', 'FR'),
  ('90fce988-56e6-4db1-840c-2ef905b18d22', 'ES'),
  ('bb1e17ed-aa63-422a-b664-0fb12c052ff3', 'FR'),
  ('73402575-a0ec-4897-b1ae-14661a0fe947', 'ES'),
  ('9c4efc06-64ce-4cd3-afb7-54c472a072c4', 'FR'),
  ('b078f8fa-59c3-46df-89dd-8f76cd55cbae', 'ES'),
  ('b5eece84-a04e-43e4-a40e-66369e767161', 'FR'),
  ('aa6b4649-9843-440f-91aa-d42db460c49b', 'FR'),
  ('22687937-334d-40e0-801a-5c895c9797e8', 'ES'),
  ('b8250272-6d06-4843-bec3-49c49131f4fc', 'ES'),
  ('9c602f53-045f-4fb9-a396-263cf1a79187', 'ES'),
  ('0a35c436-44a2-4d4c-8d2d-43dea535dc30', 'FR'),
  ('46d65331-332d-4058-84b4-540b765ed2b6', 'ES'),
  ('86c84816-f497-4f56-9fea-6d77e9b79a72', 'FR'),
  ('15c8f593-4b7a-48ee-9284-be92d089f510', 'ES'),
  ('042ebd6a-aa80-4f1f-a3d0-6632363e44e1', 'FR'),
  ('8cca3bb4-980f-415c-b51d-9ce2a4db6cef', 'ES'),
  ('44599f62-1be6-492c-823d-670dccac74fb', 'FR'),
  ('acd96e8d-a16c-4817-96c2-4345b43728ba', 'ES'),
  ('ad67dfd8-c6a5-49a7-8c15-2cd4cb558925', 'FR'),
  ('d12bf0ad-c451-4682-b2ee-bc6655a41280', 'ES'),
  ('d110be1d-a515-4e56-9045-e729cd0e0a6e', 'FR'),
  ('370a9b8d-c6eb-458f-bb9c-e88293f02db3', 'ES'),
  ('eada6403-94b7-41d9-8a9a-3d4f8c942ea9', 'FR'),
  ('81b0116b-bad1-4df7-89b7-e3044a5a33f2', 'ES'),
  ('1cfaa004-839b-4bbd-a586-ba4d8c795b75', 'ES'),
  ('80dc6de8-6697-4df9-89f0-6ee8fad8d005', 'FR'),
  ('0728f335-8c70-4bcb-b517-c08abfed9163', 'ES'),
  ('01d4e348-97a9-4bb9-a21e-7cdbe0882a44', 'FR'),
  ('58cc5a44-a787-4575-96ad-35caa1371367', 'ES'),
  ('1497fd7d-9a26-4abd-98ac-b0888a1b7ece', 'FR'),
  ('776b2080-10b6-44e6-aa55-97661d69e7de', 'ES'),
  ('e3938694-e30d-4504-b626-d51049128a62', 'FR'),
  ('130512f5-8c0b-4076-9d77-b5ac4aba370f', 'ES'),
  ('a9c4cb60-84c1-4e70-aad8-6c2e1f537ea2', 'FR'),
  ('becdfe22-f7d7-4b7e-b8d0-aca1894d8fe9', 'ES'),
  ('a9e9f768-eaaf-4fb2-9f48-a6a2e307fc71', 'FR'),
  ('c4ecf976-4f70-4b5c-abeb-4ad34e82145e', 'ES'),
  ('3b18824d-d573-4515-836d-b2e2199d3f1f', 'FR'),
  ('068e0da3-1b84-4952-b780-2769619a3757', 'ES'),
  ('d3536954-6635-4169-b6b5-be9a8d81a550', 'FR'),
  ('d7da24c0-644b-4ef7-8448-e00965a2014c', 'ES'),
  ('87d9374c-80bd-4eb9-863b-d2ae3ca0004e', 'FR'),
  ('576820fe-e627-4f40-90dc-5c575c32bb00', 'ES'),
  ('38232267-430b-43b9-82ca-5e0413074f2c', 'FR'),
  ('ae776d06-61fd-44fe-9491-b19c544f89c7', 'ES'),
  ('a2a645d9-4385-473e-a67f-1aed6e6e3506', 'FR'),
  ('4d4ab8cb-dfb1-48b9-b69d-a6ad92088df6', 'ES'),
  ('96590fcf-3e80-48df-b984-c020e59c752d', 'FR'),
  ('052c994d-521b-4c2f-abc3-1c8397f902dc', 'ES'),
  ('491bfa3c-413d-417a-9924-e937b7aabc2e', 'FR'),
  ('bcd7ec7f-3810-496d-90f3-69d8b1d0f0f7', 'ES'),
  ('2e4c618f-3711-4f0a-ba83-352dd07f193b', 'FR'),
  ('3a7ed2a2-8889-430f-842c-51f03b560bc7', 'ES'),
  ('40af921b-aef0-41fd-952e-a591bc82539e', 'FR'),
  ('b13d3f6a-790a-4d8f-b8e4-96e69b8be6f7', 'ES'),
  ('a00467f6-26ff-4684-86f1-7f81f30896d8', 'FR'),
  ('098dc2f3-1dc0-46c5-b4f0-4f94592e59da', 'ES'),
  ('97866af0-cafa-4e64-af30-13e1a50e59ea', 'FR'),
  ('9c4f7c46-582e-42cf-9a11-81f3d5b0ca8b', 'ES'),
  ('63a23be3-7a3c-41d2-9c7d-52791bd6400d', 'FR'),
  ('2d804f19-fe76-4b85-b34f-283ff4ae0796', 'ES'),
  ('2db10f6a-99de-4f77-8b0e-4625b4b72cd6', 'FR'),
  ('97ed7ab3-a7a7-4430-91c8-7a9c029cb70c', 'ES'),
  ('bb602773-a9f2-4cb7-be36-d981b74ca9ce', 'FR'),
  ('8d2cfbbb-6178-42c4-84a3-3f9830e7b5ca', 'ES'),
  ('8749a1c3-22dc-4bb9-abbd-640e59b87e1d', 'ES'),
  ('afbdb9af-31fb-4514-8713-adea42d4fa09', 'FR'),
  ('e5f9cbd4-a55f-494b-a851-070c2d19d667', 'ES'),
  ('0b41f19a-85b5-41ef-bf11-a8014d4229aa', 'FR'),
  ('b4e0639b-51bc-44b0-9d89-ef8b724cecaa', 'ES'),
  ('aa63acfe-fb22-4a59-9b21-b40243dc8cab', 'ES'),
  ('926b9b54-589c-45a7-8cc1-00591b5bba45', 'ES'),
  ('3d8dfbcb-0cce-41ea-b6b5-6d0036e94fb2', 'FR'),
  ('698b8685-a6d5-48a7-94cf-e5eeb7e7a8b0', 'ES'),
  ('417837b0-2af0-4477-aca5-9c7384602c97', 'FR'),
  ('4c03850c-32c1-488f-886d-56526b80b9a7', 'ES'),
  ('502cc612-c042-404c-8129-3cc5de6e3fd2', 'FR'),
  ('99b55549-deff-4d16-b658-396ddf3f77dc', 'ES'),
  ('912e83f0-3ef2-4bd5-b4ee-26db7c4d7498', 'FR'),
  ('f08f8464-5f99-4d63-8602-d78e28718120', 'ES'),
  ('1eded1d3-38fa-457a-955c-0386202ef931', 'FR'),
  ('b7e3931a-315b-4c31-b906-15d917bc91ba', 'ES'),
  ('11406ff5-f4a8-4593-9d7a-ce5637b96ac8', 'FR'),
  ('6d0d2c2b-d292-4dbe-9840-73784312e0d8', 'ES'),
  ('d6b8e836-22a8-4fa9-99f4-8297bdc17226', 'FR'),
  ('001626ff-787c-464a-8641-b53d9094cf5b', 'ES'),
  ('edace60e-ffe7-4d14-b6ed-b15aea4ef872', 'FR'),
  ('39aaf040-efd1-49df-a61b-87ad9b237773', 'ES'),
  ('4852252d-d732-4693-97d5-884ab955e665', 'FR'),
  ('1e14359b-c27e-43dc-af92-69de3bccdbc2', 'ES'),
  ('f0d224a1-e6c3-4089-a858-da1785c26aad', 'FR'),
  ('8e7b88cd-43ff-4c2d-913f-97e16267450a', 'ES'),
  ('d9a7b68b-a8fd-41d8-979a-5efd1e03c779', 'FR'),
  ('2126e7e1-afd6-48e0-bb0b-50075448745c', 'ES'),
  ('203f352c-029a-4965-82d0-eb11bd3ac837', 'FR'),
  ('0741b168-1ece-4feb-befa-8e44eed0ccd9', 'ES'),
  ('040d53e4-0b3c-4d3b-bcf5-70290bf4c3fd', 'FR'),
  ('7e1f3585-0ded-4409-a035-2ef7aa2cb3bd', 'ES'),
  ('6475b541-9b0a-4784-889d-ccc7e757c249', 'FR'),
  ('b8235b58-945b-44d6-9456-ddd87325c451', 'ES'),
  ('d9808e81-f197-4c65-a591-13aa8c7809e7', 'FR'),
  ('db0e1b4c-d54e-4a39-a071-ad77d83f25b5', 'ES'),
  ('c3a4aa55-0b15-4b2a-a559-d2b9be7895c9', 'FR'),
  ('40e89557-846b-4917-abc5-14bad4c69949', 'ES'),
  ('7e3d5af8-31d6-4dfd-a415-103fdd701acb', 'FR'),
  ('eda6b977-9767-42c4-b66c-16deceeb333e', 'ES'),
  ('3dd82795-b644-4f99-9da7-d49345aba9ff', 'FR'),
  ('92d84bda-f924-4818-957b-97d33e3a1bff', 'ES'),
  ('edef5fba-a750-450f-a392-ef9c9f95e19f', 'FR'),
  ('662b9bf5-6f96-4440-ac8c-314851b01dbd', 'ES'),
  ('6cb53255-7b04-4688-98cd-98eb188b9656', 'FR'),
  ('c7ec0b63-1ef8-4dca-b235-e91aeeea1494', 'ES'),
  ('602cdaf8-1977-45fe-9a62-02664a51cf7c', 'FR'),
  ('a58f64f4-2f66-43fa-b97b-d2b3bf6cf45f', 'ES'),
  ('62a573c6-3283-4c56-bc89-a4a7cd3b46da', 'FR'),
  ('099973a3-f7f7-4d3b-9312-dcf05f6bce7e', 'ES'),
  ('ed9bdea5-ebeb-4c22-80e2-c4bba9cd195f', 'FR'),
  ('2008f9eb-7ba8-4275-b69f-5b686e8a8596', 'ES'),
  ('63871ee0-cdd1-4bbb-a793-37af4daa9c08', 'FR'),
  ('03975793-4ae6-4671-a41b-d840955bf9a1', 'ES'),
  ('ae36c7ae-ccce-45c9-b32c-847e39f50cff', 'FR'),
  ('2e7812cc-9cfd-416c-b42d-d31dedc92382', 'ES'),
  ('24bda7b5-77ff-4fc9-af63-fb10ac82e27e', 'FR'),
  ('cd80ff47-1658-4e3a-8c8f-adbb11a474e1', 'ES'),
  ('7a3299ce-7b11-471c-8dfa-625e3d09f20e', 'FR'),
  ('2ac89ec3-3a47-4e9c-8f85-a471571761b2', 'ES'),
  ('58eac415-b5b9-4ffe-9fc7-e9193623f74d', 'FR'),
  ('10d8d8fd-6b6d-4f8b-81b7-312b92d103f1', 'ES'),
  ('97651ac0-046f-4360-b995-56becce073c2', 'FR'),
  ('20c3418d-936c-4e90-841d-e69adc9e5e88', 'ES'),
  ('061f8497-7944-4f9e-8c34-f6a28c41ac83', 'FR'),
  ('27a2fa74-c784-4e8a-a866-629341b37fca', 'ES'),
  ('f621329d-ce39-4802-8e5d-c20b2e883195', 'FR'),
  ('31e499d1-706a-4bdd-b4f1-2371fd37b8e9', 'ES'),
  ('99a272dc-455d-4924-95c3-f7dab45ce57d', 'FR'),
  ('b8d822cb-9c87-46c2-97cf-9a8413ad8238', 'ES'),
  ('7fdf6113-9d80-4d87-80f1-6b3f04a6452e', 'FR'),
  ('99f7e083-e2b7-4957-9609-94254ec0c007', 'ES'),
  ('d6af161e-65fd-4911-b83d-52bdde306944', 'FR'),
  ('f1d5466a-c022-47fd-9ee8-2de3bb2d0403', 'ES'),
  ('b58fc102-dece-43fc-ab65-e83977d0e88e', 'FR'),
  ('64f769bf-4549-4077-b9c1-25868d532d38', 'ES'),
  ('3233668f-05af-4a47-b294-eb6cc2b9c757', 'FR'),
  ('ef5236c0-a7a0-4e13-856b-9a0bb99bcf17', 'ES'),
  ('e106ba89-d9f9-48a2-be8a-13220d3be066', 'FR'),
  ('76fcda2b-4151-4d87-ba74-959f466a088f', 'ES'),
  ('8340c1ca-8fbf-4212-9e4c-47d8cb465681', 'FR'),
  ('0e982864-2bf0-4400-89b4-b1d2094740cb', 'ES'),
  ('f50ee4a5-cb9c-486d-ae45-292f3720a473', 'FR'),
  ('5f0a2082-6e27-4351-88bf-4242221d9374', 'ES'),
  ('6ac46d91-81f0-403c-95a0-181fcf318a4b', 'FR'),
  ('7c4aeec5-f9ca-4cc5-95c8-74733beec2c1', 'ES'),
  ('55809f52-c629-49c9-8ef0-e61f8bfaaf8a', 'FR'),
  ('c48b8182-b827-4c0a-953b-cd44b6e59a9f', 'ES'),
  ('aebc3b6b-c2ef-4d23-9e94-15a98333fe42', 'FR'),
  ('f10ad87e-1c76-4b99-82ad-d0f720530587', 'ES'),
  ('e1801482-9d16-4906-b391-c2e1fbd16d91', 'FR'),
  ('c93ce000-8b09-4a82-9128-ca833a8f661a', 'ES'),
  ('f6fc338a-0301-4ad3-b4f1-b574fa71576d', 'FR'),
  ('c0995c4d-932b-499c-a62b-e15d467042ad', 'ES'),
  ('d365e0ff-2f86-4aa3-9e91-555668be9154', 'FR'),
  ('de0a616a-57e2-4414-85e2-52378c7773a2', 'ES'),
  ('a9979cb5-78e8-443f-b8dc-d4bad1bd5a22', 'FR'),
  ('c392ab96-f74c-4b2e-995e-18d8ecabb106', 'ES'),
  ('f6e7df3d-a0b8-4145-baa3-b708111b1ffb', 'FR'),
  ('7ab3932b-50d1-44f2-ae51-6e9389c172f0', 'ES'),
  ('05adae69-6b3b-42bb-a437-6646aa8cf52a', 'FR'),
  ('3547f0e5-558e-47d4-9774-ca04c0e4563d', 'ES'),
  ('4f7a18f9-03f2-4cf2-b11d-b27365e88c4b', 'FR'),
  ('11cff011-cac8-4c73-9019-a641575a1787', 'ES'),
  ('ce31d5b0-1492-405d-bc39-85a00e1cf8d4', 'FR'),
  ('5003a2aa-66cb-4992-acd1-f48351e1262b', 'ES'),
  ('f9493806-d071-46e5-94df-af0501d7204b', 'FR'),
  ('977ad6aa-6cb0-4535-82a9-7b9ebceb89a2', 'ES'),
  ('3c611615-4ae1-4cd5-aa48-35a725739792', 'FR'),
  ('5d6cc0b8-f716-4326-8977-7bfa107e6c42', 'ES'),
  ('3ba4b213-284a-4882-b7b3-e8b6a38de6a3', 'FR'),
  ('bd66132c-8f94-4cb6-aa87-2adbcea70f37', 'ES'),
  ('b5cf8882-814d-4de7-b93f-20f7355eb11c', 'FR'),
  ('b54950cf-1af2-4a95-8466-f5382e4ec6a2', 'ES'),
  ('ef6e3179-37f8-4aa9-81f0-a4bff668286a', 'FR'),
  ('777f7158-4494-4879-b335-015ad458e128', 'ES'),
  ('87ab7623-c869-455c-90e3-36dba9841979', 'FR'),
  ('4c39ee21-46d6-46f7-9321-9f4241733330', 'ES'),
  ('61bbf21a-4d89-4e3c-9003-6b305f2e0dba', 'FR'),
  ('7ad080d2-4bfe-4c59-816f-470d1ec26c08', 'ES'),
  ('a68d2841-b656-48aa-99b0-3537aa368df2', 'FR'),
  ('cced4334-2fbf-433c-bf5a-da0caca6b36f', 'ES'),
  ('2cfe7b91-d184-42cb-beee-b9743b36c38f', 'FR'),
  ('c9c04bd6-64fb-4ef4-813c-f1bff9dcf86c', 'ES'),
  ('6d3d8cd8-5bb1-4f14-b7c6-5e39b5ccf15b', 'FR'),
  ('f8b9b0a9-e450-4bba-8e45-465b62bcf17e', 'ES'),
  ('56f6813e-9502-416b-ba4d-07f8a0019a76', 'FR'),
  ('bc55cdd0-52e7-465a-8c34-f503056b69e0', 'ES'),
  ('213b95e2-ed21-437f-9bc0-738d2a6bc732', 'FR'),
  ('759c1c01-2476-402b-b4ed-2ee2c62b529c', 'ES'),
  ('3a33afb8-337b-4523-ac4a-81906428121e', 'FR'),
  ('368b0dd7-bedd-4aa5-bc53-af1637441ca3', 'ES'),
  ('4bf62971-6dfc-4d10-a2c4-fa1343d1ef9e', 'FR'),
  ('67860330-e250-49f5-98c5-df734cfd839d', 'ES'),
  ('753551a8-95d5-4c49-bc6e-f0c430b557e9', 'FR'),
  ('560b88b6-feba-4aca-b849-2a97c7796193', 'ES'),
  ('77e96608-9cbe-4d4b-9649-45399b4213e0', 'FR'),
  ('545f7be0-5018-46be-9040-762291f7a2cb', 'IT'),
  ('5c3e4f5f-e66b-4f49-bd2d-79855f9a86da', 'FR'),
  ('a419c496-3592-4066-8527-5a00e882d6af', 'ES'),
  ('2f815cc2-4013-44bc-a206-eb2be7146bca', 'FR'),
  ('a2e8afe2-062c-439c-ba19-820b1ef708ef', 'ES'),
  ('e5c2e317-6dec-4f8f-957e-bd2b17712203', 'FR'),
  ('7fbf0b3a-6e48-47e9-b99a-92984f4a7e0a', 'ES'),
  ('f96206e0-36ec-4f96-8994-6d90debf9691', 'FR'),
  ('c6d73e65-61fa-403c-a3e7-04b40ddf56e0', 'ES'),
  ('869009df-7b67-47c7-b55d-764274f99974', 'FR'),
  ('b31b0484-2f6b-475a-8ca3-0bbcaa11296a', 'ES'),
  ('19f50336-2d56-4961-b3b3-57ee5896b914', 'FR'),
  ('de9eb4a5-2084-4d10-bba7-85fbd85f3e29', 'ES'),
  ('5497aca4-41e4-417e-9e4b-c735b28c0fcc', 'FR'),
  ('b946eb70-d3e4-42ba-8ca3-df19a38b0e64', 'ES'),
  ('9dcb97cb-9459-422a-9626-f2b6022d8c29', 'FR'),
  ('ade2a371-a637-4934-b795-77b71d36bd63', 'ES'),
  ('23c7d5f8-26d5-4acd-8071-51d16e6eb0ff', 'FR'),
  ('d0808072-2ac2-4d66-9bb3-13576a09da10', 'ES'),
  ('14d4f262-159e-4859-8310-bb771fec51a8', 'FR'),
  ('21838cd5-17f0-4dbb-b65a-c15bddd5b6a8', 'ES'),
  ('792f1ca6-dc32-465a-b19c-4cb5e865e51e', 'ES'),
  ('a301ac67-9513-4266-8a4c-6dbf2f4e7b8a', 'ES'),
  ('f424359e-2aef-4186-a8c1-c02af423ee3e', 'FR'),
  ('4b9acb38-968b-4c9a-88d2-3078efcb844d', 'ES'),
  ('3e3224bc-c754-41af-b147-632180720039', 'FR'),
  ('5261bbda-46f4-4732-bddf-229c0528ed85', 'ES'),
  ('728fb34d-38f5-4f47-bd97-c823949785e0', 'ES'),
  ('81dc2520-3095-4784-9384-7badbedd3ab9', 'ES'),
  ('dea68306-4a3b-4a59-9364-f6c9f40d75c0', 'FR'),
  ('6e341346-028a-43cf-a456-f1712cd95cf3', 'ES'),
  ('0cb88aa0-cbf3-42e7-aa34-9d9fbc18e953', 'FR'),
  ('28df0044-dd8e-45b2-8523-923bc9229a3f', 'ES'),
  ('dc671739-0d01-4b1a-9533-a35e967a04ea', 'FR'),
  ('3d6ad544-b473-4739-8c02-9d5b71b49a87', 'ES'),
  ('4e3b627d-387f-4591-8207-8cd75419eca8', 'FR'),
  ('3986aaf8-e48e-4968-ad35-579f26d4f638', 'ES'),
  ('49692104-3f88-4701-b5c2-02fb6f0ea261', 'FR'),
  ('ffdd0967-caf4-4485-aab9-dda58a8561c7', 'FR'),
  ('05eaa8ca-4c75-4310-ac50-0050576b0e58', 'ES'),
  ('08b85652-06c0-41e8-8373-188704075470', 'FR'),
  ('71cff1a1-4f6c-46ba-b6d4-636d08160e11', 'ES'),
  ('2ee71dbc-0ca1-4bc0-bb38-533ae5a8ac32', 'FR'),
  ('8476aefb-ce87-4cef-94fd-d2c519673298', 'ES'),
  ('c05871c6-cfac-404f-b8a1-1597bc89de2f', 'FR'),
  ('04257d7b-92aa-4c30-8204-b0bd5edeab10', 'ES'),
  ('406b0325-5770-49ee-a6e9-efcf9a1ba5d7', 'FR'),
  ('dff47fda-aab3-4132-ac0a-837688e41e47', 'ES'),
  ('bcff1a1d-e91a-42b0-b552-1239ff2744c7', 'ES'),
  ('7873ecdc-a5c4-4192-960f-3c01feb71ba6', 'ES'),
  ('c796fb8d-735e-43c0-836c-b35b2070f203', 'FR'),
  ('c99d27a0-c765-4e5d-bad8-1012589ad995', 'FR'),
  ('f0d7921e-f851-4b5e-b240-a11d1ad6d582', 'ES'),
  ('4b31cdd5-e889-4e34-a653-86f562667eb3', 'FR'),
  ('802203c5-9a52-4333-ac6a-5f1f2b562984', 'ES'),
  ('9ce4d490-6b65-4d9a-9644-86710df6edd2', 'FR'),
  ('8ec0ab90-0683-410d-b9b5-3a99cf0245ed', 'ES'),
  ('9af37c1f-480d-4f70-8728-58cdb47e6d93', 'FR'),
  ('96d623cf-bf18-4a85-8272-27d06f55a1e4', 'ES'),
  ('c7139cd9-9272-45de-aec4-bef4db207656', 'FR'),
  ('a04447b8-f9d0-48b6-a445-b519e310a46d', 'ES'),
  ('c76e418b-2875-4b3d-bd03-f30dd7df6d8e', 'ES'),
  ('e49d1b81-0699-4117-b350-33e7de5af6ca', 'ES'),
  ('ef786390-719c-4de4-8176-d1ae7f6bd0db', 'FR'),
  ('13bc074f-3792-4799-ac50-1b673c7cafaa', 'ES'),
  ('61f9dd0d-76ef-4cb9-867c-f922c3820f50', 'FR'),
  ('c19a966f-ccc4-4157-89d2-02f4a29d4262', 'ES'),
  ('6f080aa1-0080-45e8-9a15-ba8e9f665e5b', 'FR'),
  ('e17c744d-0f2b-4115-8cfd-fa52cef1f6f0', 'ES'),
  ('44e06278-207a-47ef-a398-026fe40c4438', 'ES'),
  ('dbf7beae-e10b-45df-be38-d8c567cbe8d8', 'FR'),
  ('82f85b86-c892-4986-91ae-33def07a8c6c', 'ES'),
  ('a57fffc3-fcd8-43ff-970d-8f3697c5cbbc', 'ES'),
  ('f0eff504-51cf-4e7a-b2d1-03f399ed6865', 'FR'),
  ('9d6eccbd-f569-4068-afcf-a61aedbb3676', 'ES'),
  ('ef40ddc2-a75e-4be0-b739-55ca11aaf537', 'FR'),
  ('8e1e1930-7ce8-4773-bdc9-2d36eb02fd5e', 'ES'),
  ('f989cb7c-0683-4bd6-a71f-2f0165c48ea3', 'ES'),
  ('e12c71cd-f687-41ff-96f6-a4d35a47ca45', 'ES'),
  ('04b39e28-6ad5-4f52-87cb-cb2084bfc940', 'ES'),
  ('f8bac26f-1397-40cb-a52f-2e6d277fe2e1', 'ES'),
  ('f8d8e488-5fc8-40ab-a047-ecee04316336', 'ES'),
  ('d85c36ee-19ff-466f-8d95-40cc093bd5f3', 'FR'),
  ('f8730115-c494-4a97-ba58-f64d8ee6b28b', 'ES'),
  ('ac673642-7bca-490c-b7b4-1e1a35eda404', 'FR'),
  ('f64a44db-baa5-4812-87a1-853d9750e252', 'ES'),
  ('47b14c1c-473a-4b55-a324-c157d0e3043c', 'ES'),
  ('4d78ee5b-f3ab-4863-b335-5bf36712c473', 'ES'),
  ('5a97ebdc-ece0-4680-b1de-5071bda48bb4', 'FR'),
  ('9ed0c0ff-eed6-45f4-848c-9b95b4783e45', 'ES'),
  ('ed90f8cd-f58e-4c08-ae47-73d0a03f7c34', 'ES'),
  ('cfee847f-d373-443a-88b2-e145c9033b60', 'ES'),
  ('809a4a03-514f-4afc-87ff-f053b0c8dbb3', 'ES'),
  ('77ae9471-87fa-4180-b8da-3db6c0ddfcf0', 'FR'),
  ('8092f1bb-3baa-432d-91c4-00b744c55922', 'ES'),
  ('20a5c478-275c-493b-a33a-c80241757fcb', 'ES'),
  ('03a9efb8-1005-4e62-add5-96f05c2750d7', 'FR'),
  ('23831361-6f52-4a6a-9d42-492afef222db', 'ES'),
  ('86f7edef-b134-4037-9c47-cf9c292cce0f', 'ES'),
  ('efa10cf4-f59e-4ec7-af6c-549c35f77dc8', 'FR'),
  ('f6ed60a1-debd-4353-806c-caab364c2863', 'ES'),
  ('15cc8e11-0cef-4eb6-abe2-595f96a499d0', 'ES'),
  ('777de9ab-b9bd-4421-8390-c4505dcfda90', 'ES'),
  ('d2ecb6e4-8d2d-4ed7-ad1c-c8d11ba47482', 'FR'),
  ('ab76c165-6b0a-4fe4-93ef-6610db046f65', 'FR'),
  ('548211fa-1816-45b8-891d-ba8b8f697210', 'ES'),
  ('2e3d16f3-82ff-470d-b40b-85e8a573a23a', 'ES'),
  ('b69d18c5-29e4-4b82-b553-50a3afe5d589', 'FR'),
  ('ad9775d7-6600-45f6-9a0b-03fdcc1497f5', 'ES'),
  ('2dcb1781-8fbc-45af-a614-f3c213b434ce', 'ES'),
  ('be8d230f-db51-4132-9a37-7c077eb042d1', 'ES'),
  ('06ba76e5-459e-4a38-b484-5992d016b26c', 'ES'),
  ('50cf42cc-5651-4374-9cba-6e6877d653e5', 'ES'),
  ('bb5bc1e7-6928-4d16-8dd7-8c906c2faae5', 'ES'),
  ('c8cfa80c-697a-46f1-903e-d80579e6e2a2', 'ES'),
  ('50e89706-b1e0-4841-8b84-fdf3830535c2', 'ES'),
  ('097dbeb7-7b11-4715-8da8-1d0b4fca0f70', 'ES'),
  ('52764284-5c54-491f-8a8c-91bc77b95929', 'ES'),
  ('c88a2752-11a5-4237-a619-88c41c514f1e', 'ES'),
  ('b9ebc77a-2564-416d-ba34-cbb17c40eb39', 'ES'),
  ('2be295b9-885a-48ed-ac59-48bb0d99a0f7', 'ES'),
  ('83589aeb-9d0e-4549-8d66-1b80fb80bd64', 'ES'),
  ('86df028f-002b-474c-89aa-cccac845e05b', 'ES'),
  ('9b387626-42d8-4ee1-a50d-7f6e42fe9c8f', 'FR'),
  ('da9df7a1-1190-4ec5-bd72-7f017246ba70', 'ES'),
  ('157c20bd-3e2c-4d31-9220-95a251961286', 'ES'),
  ('75abdd41-b62f-4db2-92c3-05799bf84214', 'ES'),
  ('20ae0c45-abe4-47a9-8ecc-2b92ed73a2f9', 'FR'),
  ('1711cb69-e4b6-4ee6-af2b-cfcca9b3f0f1', 'ES'),
  ('4eaad4d7-9bd9-40be-8a50-f142086805c9', 'FR'),
  ('8e9150e8-ef79-49e2-9b2d-7db53391e48e', 'ES'),
  ('e5c4e8b4-44f7-42fd-8382-94cf55ba4604', 'ES');

-- Guard: every listed id must still be an SDS document. If the corpus moved under us,
-- abort rather than act on the wrong rows -- this is EPA/GHS-regulated safety data.
DO $b0794$
DECLARE
  v_listed  integer;
  v_matched integer;
BEGIN
  SELECT count(*) INTO v_listed FROM b0794_foreign_language_sds;
  SELECT count(*) INTO v_matched
  FROM b0794_foreign_language_sds t
  JOIN rag.document d ON d.id = t.document_id
  WHERE d.document_kind = 'sds';

  IF v_listed <> v_matched THEN
    RAISE EXCEPTION
      'B0-794 aborted: % of % listed documents are missing or are no longer document_kind = ''sds''.',
      v_listed - v_matched, v_listed;
  END IF;
END
$b0794$;

-- 1. Take them out of scope (the B0-283 mechanism, and the live retrieval gate).
UPDATE rag.source_record sr
SET is_active = false,
    updated_at = now()
FROM rag.document d
JOIN b0794_foreign_language_sds t ON t.document_id = d.id
WHERE sr.id = d.source_record_id
  AND sr.is_active = true;

-- 2. Remove their chunks and embeddings from the retrievable index. Mirrors what
--    rag.sync_sds_chunks does for an inactive SDS document.
DELETE FROM rag.document_chunk dc
USING b0794_foreign_language_sds t
WHERE dc.document_id = t.document_id;

-- 3. Correct the language metadata, preserving the prior value exactly once.
UPDATE rag.document d
SET language_code = t.detected_locale,
    metadata = coalesce(d.metadata, '{}'::jsonb) || jsonb_build_object(
      'b0794_language_reclassification',
      jsonb_build_object(
        'previous_language_code', d.language_code,
        'detected_locale',        t.detected_locale,
        'method',                 'franc over rag.document.body_text (evaluateSdsContentLanguage)',
        'ticket',                 'B0-794'
      )
    ),
    updated_at = now()
FROM b0794_foreign_language_sds t
WHERE d.id = t.document_id
  AND d.language_code IS DISTINCT FROM t.detected_locale
  AND NOT (coalesce(d.metadata, '{}'::jsonb) ? 'b0794_language_reclassification');

COMMIT;
