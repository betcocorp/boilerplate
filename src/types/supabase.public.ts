export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.17"
  }
  public: {
    Tables: {
      app_user: {
        Row: {
          betco_company_id: string | null
          created_at: string
          deleted_at: string | null
          department: string | null
          division: string | null
          edit_all: boolean
          email: string | null
          first_name: string | null
          has_user_switcher: boolean
          is_active: boolean
          is_salesperson: boolean
          last_name: string | null
          name: string | null
          phone: string | null
          title: string | null
          updated_at: string
          user_id: string
          user_name: string | null
          user_security_role: string | null
        }
        Insert: {
          betco_company_id?: string | null
          created_at?: string
          deleted_at?: string | null
          department?: string | null
          division?: string | null
          edit_all?: boolean
          email?: string | null
          first_name?: string | null
          has_user_switcher?: boolean
          is_active?: boolean
          is_salesperson?: boolean
          last_name?: string | null
          name?: string | null
          phone?: string | null
          title?: string | null
          updated_at?: string
          user_id: string
          user_name?: string | null
          user_security_role?: string | null
        }
        Update: {
          betco_company_id?: string | null
          created_at?: string
          deleted_at?: string | null
          department?: string | null
          division?: string | null
          edit_all?: boolean
          email?: string | null
          first_name?: string | null
          has_user_switcher?: boolean
          is_active?: boolean
          is_salesperson?: boolean
          last_name?: string | null
          name?: string | null
          phone?: string | null
          title?: string | null
          updated_at?: string
          user_id?: string
          user_name?: string | null
          user_security_role?: string | null
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          conversation_id: string | null
          created_at: string
          event_type: string
          id: string
          payload: Json
          workflow_run_id: string | null
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string
          event_type: string
          id?: string
          payload?: Json
          workflow_run_id?: string | null
        }
        Update: {
          conversation_id?: string | null
          created_at?: string
          event_type?: string
          id?: string
          payload?: Json
          workflow_run_id?: string | null
        }
        Relationships: []
      }
      event_logging: {
        Row: {
          created_at: string
          event: string
          id: string
          meta: Json
          sentry: Json
          session_id: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          event: string
          id?: string
          meta?: Json
          sentry?: Json
          session_id?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          event?: string
          id?: string
          meta?: Json
          sentry?: Json
          session_id?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      group_permission: {
        Row: {
          created_at: string
          deleted_at: string | null
          group_permission_id: string
          permission_group_id: string
          permission_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          group_permission_id: string
          permission_group_id: string
          permission_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          group_permission_id?: string
          permission_group_id?: string
          permission_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_permission_permission_group_id_fkey"
            columns: ["permission_group_id"]
            isOneToOne: false
            referencedRelation: "permission_group"
            referencedColumns: ["permission_group_id"]
          },
          {
            foreignKeyName: "group_permission_permission_id_fkey"
            columns: ["permission_id"]
            isOneToOne: false
            referencedRelation: "permission"
            referencedColumns: ["permission_id"]
          },
        ]
      }
      permission: {
        Row: {
          created_at: string
          deleted_at: string | null
          description: string | null
          permission_id: string
          selector: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          permission_id: string
          selector: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          permission_id?: string
          selector?: string
          updated_at?: string
        }
        Relationships: []
      }
      permission_group: {
        Row: {
          created_at: string
          deleted_at: string | null
          description: string | null
          end_at: string | null
          permission_group_id: string
          selector: string
          start_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          end_at?: string | null
          permission_group_id: string
          selector: string
          start_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          end_at?: string | null
          permission_group_id?: string
          selector?: string
          start_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      settings: {
        Row: {
          allowed_values: string[] | null
          created_at: string
          default_value: string | null
          description: string | null
          id: string
          key: string
          updated_at: string
          value: string | null
          value_type: string
        }
        Insert: {
          allowed_values?: string[] | null
          created_at?: string
          default_value?: string | null
          description?: string | null
          id?: string
          key: string
          updated_at?: string
          value?: string | null
          value_type: string
        }
        Update: {
          allowed_values?: string[] | null
          created_at?: string
          default_value?: string | null
          description?: string | null
          id?: string
          key?: string
          updated_at?: string
          value?: string | null
          value_type?: string
        }
        Relationships: []
      }
      user_group_permission: {
        Row: {
          created_at: string
          deleted_at: string | null
          entity_id: string
          entity_type: string
          updated_at: string
          user_group_permission_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          entity_id: string
          entity_type: string
          updated_at?: string
          user_group_permission_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          entity_id?: string
          entity_type?: string
          updated_at?: string
          user_group_permission_id?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      delete_permission_group_with_resources: {
        Args: {
          p_actor_email: string
          p_actor_name: string
          p_actor_user_id: string
          p_group_id: string
          p_trace_id: string
        }
        Returns: {
          deleted_selector: string
          group_removed: boolean
          members_removed: number
          permissions_removed: number
        }[]
      }
      event_analytics_summary: {
        Args: { p_days?: number; p_groups?: string[] }
        Returns: Json
      }
      get_user_permission_bundle: {
        Args: { p_user_id: string }
        Returns: {
          row_kind: string
          selector: string
        }[]
      }
      merge_permission_groups: {
        Args: {
          p_actor_email: string
          p_actor_name: string
          p_actor_user_id: string
          p_delete_source: boolean
          p_source_group_id: string
          p_target_group_id: string
          p_trace_id: string
        }
        Returns: {
          deleted_source: boolean
          permissions_merged: number
          prior_source_permission_count: number
          prior_source_user_count: number
          prior_target_permission_count: number
          prior_target_user_count: number
          source_selector: string
          target_selector: string
          users_merged: number
        }[]
      }
      preview_permission_group_merge: {
        Args: { p_source_group_id: string; p_target_group_id: string }
        Returns: {
          permissions_to_add: number
          source_selector: string
          target_selector: string
          users_to_add: number
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
