-- An access token used by an AI assistant through the MCP server sees e-mail addresses, phone numbers and other
-- personal details masked unless the administrator allowed this token to receive them.
alter table api_tokens add column share_personal_data boolean not null default false;
