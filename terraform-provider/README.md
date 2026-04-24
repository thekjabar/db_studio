# terraform-provider-dbstudio

A Terraform / OpenTofu provider for DB Studio.

## Status

v0.1 — ships with:

- **Resource** `dbstudio_connection` — CRUD for database connections.
- **Data source** `dbstudio_connection` — look up an existing connection by id.

Planned: `dbstudio_workspace`, `dbstudio_workspace_member`, `dbstudio_webhook`.
Ship one at a time, each under ~300 LOC, using the patterns in
`connection_resource.go`.

## Build

```bash
cd terraform-provider
go build -o terraform-provider-dbstudio
```

## Local dev

Put this in `~/.terraformrc`:

```hcl
provider_installation {
  dev_overrides {
    "dbstudio/dbstudio" = "/absolute/path/to/terraform-provider/"
  }
  direct {}
}
```

Then `terraform init` in a module and the override is used.

## Example

```hcl
terraform {
  required_providers {
    dbstudio = {
      source  = "dbstudio/dbstudio"
      version = "0.1.0"
    }
  }
}

provider "dbstudio" {
  url   = "https://studio.example.com/api"
  token = var.dbstudio_token
}

resource "dbstudio_connection" "prod" {
  name     = "prod-readonly"
  dialect  = "POSTGRES"
  host     = "db.prod.example.com"
  port     = 5432
  database = "app"
  username = "readonly"
  password = var.prod_password
  ssl_mode = "verify-full"
  read_only = true
  require_review = true
}
```

## Release

Standard Terraform Registry: tag `v0.1.0`, push a GitHub release with
goreleaser outputs matching the naming convention. See
[terraform-provider-scaffolding-framework](https://github.com/hashicorp/terraform-provider-scaffolding-framework)
for a ready-made `.goreleaser.yml` you can drop in.
