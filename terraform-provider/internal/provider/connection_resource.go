package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

type connectionResource struct {
	client *Client
}

func NewConnectionResource() resource.Resource {
	return &connectionResource{}
}

type connectionModel struct {
	ID                 types.String `tfsdk:"id"`
	Name               types.String `tfsdk:"name"`
	Dialect            types.String `tfsdk:"dialect"`
	Host               types.String `tfsdk:"host"`
	Port               types.Int64  `tfsdk:"port"`
	Database           types.String `tfsdk:"database"`
	Username           types.String `tfsdk:"username"`
	Password           types.String `tfsdk:"password"`
	SSLMode            types.String `tfsdk:"ssl_mode"`
	ReadOnly           types.Bool   `tfsdk:"read_only"`
	StatementTimeoutMs types.Int64  `tfsdk:"statement_timeout_ms"`
	WorkspaceID        types.String `tfsdk:"workspace_id"`
	RequireReview      types.Bool   `tfsdk:"require_review"`
}

func (r *connectionResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_connection"
}

func (r *connectionResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A database connection. The password is stored encrypted on the DB Studio server.",
		Attributes: map[string]schema.Attribute{
			"id":       schema.StringAttribute{Computed: true},
			"name":     schema.StringAttribute{Required: true},
			"dialect":  schema.StringAttribute{Required: true, Description: "POSTGRES | MYSQL | SQLITE | MSSQL"},
			"host":     schema.StringAttribute{Required: true},
			"port":     schema.Int64Attribute{Required: true},
			"database": schema.StringAttribute{Required: true},
			"username": schema.StringAttribute{Required: true},
			"password": schema.StringAttribute{
				Required:    true,
				Sensitive:   true,
				Description: "Sent once; the server encrypts it and never returns plaintext.",
			},
			"ssl_mode": schema.StringAttribute{
				Optional:    true,
				Description: "disable | require | verify-ca | verify-full",
			},
			"read_only": schema.BoolAttribute{
				Optional: true, Computed: true,
				Default:     booldefault.StaticBool(false),
				Description: "When true, the driver refuses writes regardless of role.",
			},
			"statement_timeout_ms": schema.Int64Attribute{
				Optional: true, Computed: true,
				Default: int64default.StaticInt64(30000),
			},
			"workspace_id": schema.StringAttribute{Optional: true},
			"require_review": schema.BoolAttribute{
				Optional: true, Computed: true,
				Default:     booldefault.StaticBool(false),
				Description: "When true, destructive SQL needs an approved review request.",
			},
		},
	}
}

func (r *connectionResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}
	client, ok := req.ProviderData.(*Client)
	if !ok {
		resp.Diagnostics.AddError("provider data", "expected *Client")
		return
	}
	r.client = client
}

// ---- helpers ----

type connectionAPIBody struct {
	Name               string             `json:"name"`
	Dialect            string             `json:"dialect"`
	Credentials        connectionCredsAPI `json:"credentials"`
	ReadOnly           bool               `json:"readOnly"`
	StatementTimeoutMs int64              `json:"statementTimeoutMs"`
	WorkspaceID        *string            `json:"workspaceId,omitempty"`
	RequireReview      bool               `json:"requireReview"`
}

type connectionCredsAPI struct {
	Host     string  `json:"host"`
	Port     int64   `json:"port"`
	Database string  `json:"database"`
	User     string  `json:"user"`
	Password string  `json:"password"`
	SSLMode  *string `json:"sslMode,omitempty"`
}

type connectionAPIResponse struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (m *connectionModel) toAPI() connectionAPIBody {
	var ws *string
	if !m.WorkspaceID.IsNull() && !m.WorkspaceID.IsUnknown() && m.WorkspaceID.ValueString() != "" {
		v := m.WorkspaceID.ValueString()
		ws = &v
	}
	var ssl *string
	if !m.SSLMode.IsNull() && !m.SSLMode.IsUnknown() && m.SSLMode.ValueString() != "" {
		v := m.SSLMode.ValueString()
		ssl = &v
	}
	return connectionAPIBody{
		Name:               m.Name.ValueString(),
		Dialect:            m.Dialect.ValueString(),
		ReadOnly:           m.ReadOnly.ValueBool(),
		StatementTimeoutMs: m.StatementTimeoutMs.ValueInt64(),
		WorkspaceID:        ws,
		RequireReview:      m.RequireReview.ValueBool(),
		Credentials: connectionCredsAPI{
			Host:     m.Host.ValueString(),
			Port:     m.Port.ValueInt64(),
			Database: m.Database.ValueString(),
			User:     m.Username.ValueString(),
			Password: m.Password.ValueString(),
			SSLMode:  ssl,
		},
	}
}

// ---- CRUD ----

func (r *connectionResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan connectionModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var out connectionAPIResponse
	if err := r.client.doJSON("POST", "/connections", plan.toAPI(), &out); err != nil {
		resp.Diagnostics.AddError("create connection", err.Error())
		return
	}
	plan.ID = types.StringValue(out.ID)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *connectionResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state connectionModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	// Server returns sanitized fields only; password stays null-local.
	var row struct {
		ID                 string  `json:"id"`
		Name               string  `json:"name"`
		Dialect            string  `json:"dialect"`
		Host               string  `json:"host"`
		Port               int64   `json:"port"`
		Database           string  `json:"database"`
		User               string  `json:"user"`
		SSLMode            *string `json:"sslMode,omitempty"`
		ReadOnly           bool    `json:"readOnly"`
		StatementTimeoutMs int64   `json:"statementTimeoutMs"`
		WorkspaceID        *string `json:"workspaceId,omitempty"`
		RequireReview      bool    `json:"requireReview"`
	}
	if err := r.client.doJSON("GET", fmt.Sprintf("/connections/%s", state.ID.ValueString()), nil, &row); err != nil {
		// Any 404 means the resource was deleted out of band; let TF recreate.
		resp.State.RemoveResource(ctx)
		return
	}
	state.Name = types.StringValue(row.Name)
	state.Dialect = types.StringValue(row.Dialect)
	state.Host = types.StringValue(row.Host)
	state.Port = types.Int64Value(row.Port)
	state.Database = types.StringValue(row.Database)
	state.Username = types.StringValue(row.User)
	if row.SSLMode != nil {
		state.SSLMode = types.StringValue(*row.SSLMode)
	} else {
		state.SSLMode = types.StringNull()
	}
	state.ReadOnly = types.BoolValue(row.ReadOnly)
	state.StatementTimeoutMs = types.Int64Value(row.StatementTimeoutMs)
	if row.WorkspaceID != nil {
		state.WorkspaceID = types.StringValue(*row.WorkspaceID)
	}
	state.RequireReview = types.BoolValue(row.RequireReview)
	resp.Diagnostics.Append(resp.State.Set(ctx, state)...)
}

func (r *connectionResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan connectionModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	// Only resend password if it changed. The server's PATCH accepts a full or
	// partial credentials object. For simplicity we always send it — the
	// server re-encrypts idempotently.
	if err := r.client.doJSON("PATCH", fmt.Sprintf("/connections/%s", plan.ID.ValueString()), plan.toAPI(), nil); err != nil {
		resp.Diagnostics.AddError("update connection", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *connectionResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state connectionModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.doJSON("DELETE", fmt.Sprintf("/connections/%s", state.ID.ValueString()), nil, nil); err != nil {
		resp.Diagnostics.AddError("delete connection", err.Error())
	}
}

func (r *connectionResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}
