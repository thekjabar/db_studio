package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

type connectionDataSource struct {
	client *Client
}

func NewConnectionDataSource() datasource.DataSource {
	return &connectionDataSource{}
}

type connectionDataModel struct {
	ID       types.String `tfsdk:"id"`
	Name     types.String `tfsdk:"name"`
	Dialect  types.String `tfsdk:"dialect"`
	Host     types.String `tfsdk:"host"`
	Port     types.Int64  `tfsdk:"port"`
	Database types.String `tfsdk:"database"`
	Username types.String `tfsdk:"username"`
}

func (d *connectionDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_connection"
}

func (d *connectionDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Look up an existing connection by id.",
		Attributes: map[string]schema.Attribute{
			"id":       schema.StringAttribute{Required: true},
			"name":     schema.StringAttribute{Computed: true},
			"dialect":  schema.StringAttribute{Computed: true},
			"host":     schema.StringAttribute{Computed: true},
			"port":     schema.Int64Attribute{Computed: true},
			"database": schema.StringAttribute{Computed: true},
			"username": schema.StringAttribute{Computed: true},
		},
	}
}

func (d *connectionDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}
	client, ok := req.ProviderData.(*Client)
	if !ok {
		resp.Diagnostics.AddError("provider data", "expected *Client")
		return
	}
	d.client = client
}

func (d *connectionDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var model connectionDataModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &model)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var row struct {
		Name     string `json:"name"`
		Dialect  string `json:"dialect"`
		Host     string `json:"host"`
		Port     int64  `json:"port"`
		Database string `json:"database"`
		User     string `json:"user"`
	}
	if err := d.client.doJSON("GET", fmt.Sprintf("/connections/%s", model.ID.ValueString()), nil, &row); err != nil {
		resp.Diagnostics.AddError("read connection", err.Error())
		return
	}
	model.Name = types.StringValue(row.Name)
	model.Dialect = types.StringValue(row.Dialect)
	model.Host = types.StringValue(row.Host)
	model.Port = types.Int64Value(row.Port)
	model.Database = types.StringValue(row.Database)
	model.Username = types.StringValue(row.User)
	resp.Diagnostics.Append(resp.State.Set(ctx, model)...)
}
