-- An implementation consultant works through an access token with the "implementation" role: it configures the
-- centre and loads reference data, and never handles money or users.
alter table api_tokens drop constraint api_tokens_role_check;
alter table api_tokens add constraint api_tokens_role_check check (role in ('secretariat', 'accountant', 'editor', 'implementation'));
