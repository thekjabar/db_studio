package provider

import (
	"context"
	"net/http"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// dbstudioProvider wires up resources + data sources.
type dbstudioProvider struct {
	version string
}

// dbstudioProviderModel is the Terraform-facing config shape.
type dbstudioProviderModel struct {
	URL   types.String `tfsdk:"url"`
	Token types.String `tfsdk:"token"`
}

// Client is passed to each resource / data source via ConfigureRequest.
type Client struct {
	URL   string
	Token string
	HTTP  *http.Client
}

func New(version string) func() provider.Provider {
	return func() provider.Provider {
		return &dbstudioProvider{version: version}
	}
}

func (p *dbstudioProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "dbstudio"
	resp.Version = p.version
}

func (p *dbstudioProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "The DB Studio provider lets Terraform manage connections and workspace memberships.",
		Attributes: map[string]schema.Attribute{
			"url": schema.StringAttribute{
				Required:    true,
				Description: "Base URL of the DB Studio API, e.g. https://studio.example.com/api",
			},
			"token": schema.StringAttribute{
				Required:    true,
				Sensitive:   true,
				Description: "API key with permission to manage the targeted resources.",
			},
		},
	}
}

func (p *dbstudioProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var cfg dbstudioProviderModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if cfg.URL.IsNull() || cfg.URL.IsUnknown() {
		resp.Diagnostics.AddError("missing url", "The provider block must set `url`.")
		return
	}
	if cfg.Token.IsNull() || cfg.Token.IsUnknown() {
		resp.Diagnostics.AddError("missing token", "The provider block must set `token`.")
		return
	}
	client := &Client{
		URL:   trimTrailingSlash(cfg.URL.ValueString()),
		Token: cfg.Token.ValueString(),
		HTTP:  &http.Client{},
	}
	resp.DataSourceData = client
	resp.ResourceData = client
}

func (p *dbstudioProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		NewConnectionResource,
	}
}

func (p *dbstudioProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{
		NewConnectionDataSource,
	}
}

func trimTrailingSlash(s string) string {
	for len(s) > 0 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return s
}
