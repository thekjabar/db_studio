// Terraform provider for DB Studio.
//
// Declarative management of DB Studio resources. Connections and workspace
// memberships are the two surfaces most often IaC'd — the rest of the API
// (dashboards, notebooks) is typically authored in the UI and doesn't need
// plan/apply semantics.
//
// Usage:
//   terraform {
//     required_providers {
//       dbstudio = {
//         source = "dbstudio/dbstudio"
//         version = "0.1.0"
//       }
//     }
//   }
//
//   provider "dbstudio" {
//     url   = "https://studio.example.com/api"
//     token = var.dbstudio_token
//   }
//
//   resource "dbstudio_connection" "prod_readonly" {
//     name     = "prod-readonly"
//     dialect  = "POSTGRES"
//     host     = "db.prod.example.com"
//     port     = 5432
//     database = "app"
//     username = "readonly"
//     password = var.prod_readonly_password
//     ssl_mode = "verify-full"
//     read_only = true
//   }

package main

import (
	"context"
	"flag"
	"log"

	"github.com/dbstudio/terraform-provider-dbstudio/internal/provider"
	"github.com/hashicorp/terraform-plugin-framework/providerserver"
)

func main() {
	var debug bool
	flag.BoolVar(&debug, "debug", false, "set to true to run the provider with support for debuggers like delve")
	flag.Parse()

	err := providerserver.Serve(context.Background(), provider.New("0.1.0"), providerserver.ServeOpts{
		Address: "registry.terraform.io/dbstudio/dbstudio",
		Debug:   debug,
	})
	if err != nil {
		log.Fatal(err.Error())
	}
}
