# Todo

- [x] Seed data from legacy tables into new `rag` schema
- [x] Decide how to best generate vectors and modify tables to support
- [x] Have cursor create a simple gui that has vector search enabled and displays similarity for testing purposes
  - [x] Run testing to fine tune similarity and ensure we providing the best accuracy
- [x] Decide whether to create a separate repository for things like webhooks and edge functions
  - [ ] Create the webhooks and edge functions to synchronize the data between legacy and rag
- [ ] Create the sync scripts needed to pull source data into legacy tables to handle updates.
- [ ] Add a test runner that will take a set of questions and run it through the prompt, test and then give a report on the results.

