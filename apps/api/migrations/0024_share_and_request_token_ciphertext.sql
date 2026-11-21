-- Store AES-GCM encrypted share / file-request tokens so owners and managers can
-- re-copy active URLs from list endpoints without storing plaintext tokens.
ALTER TABLE shared_links ADD COLUMN token_ciphertext TEXT;
ALTER TABLE file_requests ADD COLUMN token_ciphertext TEXT;
