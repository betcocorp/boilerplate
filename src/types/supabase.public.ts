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
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      agent_conversations: {
        Row: {
          created_at: string
          id: string
          latest_model: string | null
          latest_openai_response_id: string | null
          openai_conversation_id: string | null
          status: string
          title: string
          updated_at: string
          user_id: string | null
          workspace_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          latest_model?: string | null
          latest_openai_response_id?: string | null
          openai_conversation_id?: string | null
          status?: string
          title?: string
          updated_at?: string
          user_id?: string | null
          workspace_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          latest_model?: string | null
          latest_openai_response_id?: string | null
          openai_conversation_id?: string | null
          status?: string
          title?: string
          updated_at?: string
          user_id?: string | null
          workspace_id?: string | null
        }
        Relationships: []
      }
      agent_message_feedback: {
        Row: {
          comment: string | null
          conversation_id: string
          created_at: string
          id: string
          message_id: string
          rating: string
          reason_code: string | null
          updated_at: string
          workflow_run_id: string | null
        }
        Insert: {
          comment?: string | null
          conversation_id: string
          created_at?: string
          id?: string
          message_id: string
          rating: string
          reason_code?: string | null
          updated_at?: string
          workflow_run_id?: string | null
        }
        Update: {
          comment?: string | null
          conversation_id?: string
          created_at?: string
          id?: string
          message_id?: string
          rating?: string
          reason_code?: string | null
          updated_at?: string
          workflow_run_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_message_feedback_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_message_feedback_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "agent_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_message_feedback_workflow_run_id_fkey"
            columns: ["workflow_run_id"]
            isOneToOne: false
            referencedRelation: "workflow_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_messages: {
        Row: {
          content: Json
          conversation_id: string
          created_at: string
          id: string
          openai_response_id: string | null
          plain_text: string | null
          role: string
          tool_name: string | null
        }
        Insert: {
          content?: Json
          conversation_id: string
          created_at?: string
          id?: string
          openai_response_id?: string | null
          plain_text?: string | null
          role: string
          tool_name?: string | null
        }
        Update: {
          content?: Json
          conversation_id?: string
          created_at?: string
          id?: string
          openai_response_id?: string | null
          plain_text?: string | null
          role?: string
          tool_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_suggestions: {
        Row: {
          content: string
          created_at: string
          entity_id: string
          entity_type: string
          id: string
          model: string | null
          sort_order: number
          title: string
        }
        Insert: {
          content: string
          created_at?: string
          entity_id: string
          entity_type: string
          id?: string
          model?: string | null
          sort_order?: number
          title: string
        }
        Update: {
          content?: string
          created_at?: string
          entity_id?: string
          entity_type?: string
          id?: string
          model?: string | null
          sort_order?: number
          title?: string
        }
        Relationships: []
      }
      api_app: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
          project_id: string
          rate_limit_per_minute: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          project_id: string
          rate_limit_per_minute?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          project_id?: string
          rate_limit_per_minute?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_app_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "api_project"
            referencedColumns: ["id"]
          },
        ]
      }
      api_key: {
        Row: {
          app_id: string
          created_at: string
          expires_at: string | null
          id: string
          label: string | null
          last_used_at: string | null
          prefix: string
          revoked_at: string | null
          token_hash: string
        }
        Insert: {
          app_id: string
          created_at?: string
          expires_at?: string | null
          id?: string
          label?: string | null
          last_used_at?: string | null
          prefix: string
          revoked_at?: string | null
          token_hash: string
        }
        Update: {
          app_id?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          label?: string | null
          last_used_at?: string | null
          prefix?: string
          revoked_at?: string | null
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_key_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "api_app"
            referencedColumns: ["id"]
          },
        ]
      }
      api_project: {
        Row: {
          contact_email: string | null
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        Insert: {
          contact_email?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          contact_email?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      api_request_log: {
        Row: {
          app_id: string | null
          completion_tokens: number | null
          created_at: string
          error: string | null
          id: string
          key_id: string | null
          latency_ms: number | null
          method: string
          path: string
          project_id: string | null
          prompt_tokens: number | null
          status: number
          total_tokens: number | null
        }
        Insert: {
          app_id?: string | null
          completion_tokens?: number | null
          created_at?: string
          error?: string | null
          id?: string
          key_id?: string | null
          latency_ms?: number | null
          method: string
          path: string
          project_id?: string | null
          prompt_tokens?: number | null
          status: number
          total_tokens?: number | null
        }
        Update: {
          app_id?: string | null
          completion_tokens?: number | null
          created_at?: string
          error?: string | null
          id?: string
          key_id?: string | null
          latency_ms?: number | null
          method?: string
          path?: string
          project_id?: string | null
          prompt_tokens?: number | null
          status?: number
          total_tokens?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "api_request_log_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "api_app"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_request_log_key_id_fkey"
            columns: ["key_id"]
            isOneToOne: false
            referencedRelation: "api_key"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_request_log_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "api_project"
            referencedColumns: ["id"]
          },
        ]
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
        Relationships: [
          {
            foreignKeyName: "audit_logs_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_workflow_run_id_fkey"
            columns: ["workflow_run_id"]
            isOneToOne: false
            referencedRelation: "workflow_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      cross_reference_override: {
        Row: {
          betco_product_key: string | null
          betco_product_line_id: string | null
          betco_product_url: string | null
          betco_title: string
          chemistry_class: string | null
          competitor_brand: string
          competitor_epa_reg: string | null
          competitor_product: string
          confidence: number
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          rationale: string | null
          updated_at: string
        }
        Insert: {
          betco_product_key?: string | null
          betco_product_line_id?: string | null
          betco_product_url?: string | null
          betco_title: string
          chemistry_class?: string | null
          competitor_brand: string
          competitor_epa_reg?: string | null
          competitor_product: string
          confidence?: number
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          rationale?: string | null
          updated_at?: string
        }
        Update: {
          betco_product_key?: string | null
          betco_product_line_id?: string | null
          betco_product_url?: string | null
          betco_title?: string
          chemistry_class?: string | null
          competitor_brand?: string
          competitor_epa_reg?: string | null
          competitor_product?: string
          confidence?: number
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          rationale?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      orphan_ignore: {
        Row: {
          check_key: string
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          reason: string | null
          ref_id: string
          updated_at: string
        }
        Insert: {
          check_key: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          reason?: string | null
          ref_id: string
          updated_at?: string
        }
        Update: {
          check_key?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          reason?: string | null
          ref_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      product_category: {
        Row: {
          aliases: string[]
          created_at: string
          depth: number
          key: string
          name: string
          parent_key: string | null
          path: string[]
          source: string
          source_value: string | null
          updated_at: string
        }
        Insert: {
          aliases?: string[]
          created_at?: string
          depth?: number
          key: string
          name: string
          parent_key?: string | null
          path?: string[]
          source?: string
          source_value?: string | null
          updated_at?: string
        }
        Update: {
          aliases?: string[]
          created_at?: string
          depth?: number
          key?: string
          name?: string
          parent_key?: string | null
          path?: string[]
          source?: string
          source_value?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      product_category_link: {
        Row: {
          category_key: string
          confidence: number
          created_at: string
          prod_line_id: string | null
          prod_line_key: string
          source: string
        }
        Insert: {
          category_key: string
          confidence?: number
          created_at?: string
          prod_line_id?: string | null
          prod_line_key: string
          source?: string
        }
        Update: {
          category_key?: string
          confidence?: number
          created_at?: string
          prod_line_id?: string | null
          prod_line_key?: string
          source?: string
        }
        Relationships: []
      }
      review_tasks: {
        Row: {
          created_at: string
          id: string
          payload: Json
          reason: string
          status: string
          updated_at: string
          workflow_run_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          payload?: Json
          reason: string
          status?: string
          updated_at?: string
          workflow_run_id: string
        }
        Update: {
          created_at?: string
          id?: string
          payload?: Json
          reason?: string
          status?: string
          updated_at?: string
          workflow_run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_tasks_workflow_run_id_fkey"
            columns: ["workflow_run_id"]
            isOneToOne: false
            referencedRelation: "workflow_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      test_items: {
        Row: {
          created_at: string
          expected_canonical_product: string | null
          expected_reason_code: string | null
          expected_result_type: string | null
          expected_should_answer: boolean | null
          id: string
          input_payload: Json
          metadata: Json
          prompt: string
          prompt_category: string | null
          row_index: number
          test_id: string
        }
        Insert: {
          created_at?: string
          expected_canonical_product?: string | null
          expected_reason_code?: string | null
          expected_result_type?: string | null
          expected_should_answer?: boolean | null
          id?: string
          input_payload?: Json
          metadata?: Json
          prompt: string
          prompt_category?: string | null
          row_index: number
          test_id: string
        }
        Update: {
          created_at?: string
          expected_canonical_product?: string | null
          expected_reason_code?: string | null
          expected_result_type?: string | null
          expected_should_answer?: boolean | null
          id?: string
          input_payload?: Json
          metadata?: Json
          prompt?: string
          prompt_category?: string | null
          row_index?: number
          test_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "test_items_test_id_fkey"
            columns: ["test_id"]
            isOneToOne: false
            referencedRelation: "tests"
            referencedColumns: ["id"]
          },
        ]
      }
      test_result_items: {
        Row: {
          created_at: string
          elapsed_ms: number
          error_message: string | null
          id: string
          passed: boolean
          response_payload: Json | null
          response_text: string | null
          row_index: number
          status: string
          test_item_id: string
          test_result_id: string
          ttft_ms: number | null
        }
        Insert: {
          created_at?: string
          elapsed_ms: number
          error_message?: string | null
          id?: string
          passed?: boolean
          response_payload?: Json | null
          response_text?: string | null
          row_index: number
          status?: string
          test_item_id: string
          test_result_id: string
          ttft_ms?: number | null
        }
        Update: {
          created_at?: string
          elapsed_ms?: number
          error_message?: string | null
          id?: string
          passed?: boolean
          response_payload?: Json | null
          response_text?: string | null
          row_index?: number
          status?: string
          test_item_id?: string
          test_result_id?: string
          ttft_ms?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "test_result_items_test_item_id_fkey"
            columns: ["test_item_id"]
            isOneToOne: false
            referencedRelation: "test_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "test_result_items_test_result_id_fkey"
            columns: ["test_result_id"]
            isOneToOne: false
            referencedRelation: "test_results"
            referencedColumns: ["id"]
          },
        ]
      }
      test_results: {
        Row: {
          avg_confidence: number | null
          avg_similarity: number | null
          completed_at: string | null
          created_at: string
          elapsed_ms: number | null
          failed_items: number
          id: string
          insights: Json | null
          insights_generated_at: string | null
          notes: string | null
          passed_items: number
          retrieval_strategy: string | null
          run_mode: string
          run_options: Json
          started_at: string
          status: string
          summary: Json
          test_id: string
          total_items: number
        }
        Insert: {
          avg_confidence?: number | null
          avg_similarity?: number | null
          completed_at?: string | null
          created_at?: string
          elapsed_ms?: number | null
          failed_items?: number
          id?: string
          insights?: Json | null
          insights_generated_at?: string | null
          notes?: string | null
          passed_items?: number
          retrieval_strategy?: string | null
          run_mode?: string
          run_options?: Json
          started_at?: string
          status?: string
          summary?: Json
          test_id: string
          total_items?: number
        }
        Update: {
          avg_confidence?: number | null
          avg_similarity?: number | null
          completed_at?: string | null
          created_at?: string
          elapsed_ms?: number | null
          failed_items?: number
          id?: string
          insights?: Json | null
          insights_generated_at?: string | null
          notes?: string | null
          passed_items?: number
          retrieval_strategy?: string | null
          run_mode?: string
          run_options?: Json
          started_at?: string
          status?: string
          summary?: Json
          test_id?: string
          total_items?: number
        }
        Relationships: [
          {
            foreignKeyName: "test_results_test_id_fkey"
            columns: ["test_id"]
            isOneToOne: false
            referencedRelation: "tests"
            referencedColumns: ["id"]
          },
        ]
      }
      tests: {
        Row: {
          confidence_floor: number
          id: string
          intended_agent: string | null
          metadata: Json
          name: string
          row_count: number
          similarity_floor: number
          source_bucket: string
          source_file_name: string
          source_key: string
          status: string
          suite_version: string
          updated_at: string
          uploaded_at: string
        }
        Insert: {
          confidence_floor?: number
          id?: string
          intended_agent?: string | null
          metadata?: Json
          name: string
          row_count?: number
          similarity_floor?: number
          source_bucket: string
          source_file_name: string
          source_key: string
          status?: string
          suite_version?: string
          updated_at?: string
          uploaded_at?: string
        }
        Update: {
          confidence_floor?: number
          id?: string
          intended_agent?: string | null
          metadata?: Json
          name?: string
          row_count?: number
          similarity_floor?: number
          source_bucket?: string
          source_file_name?: string
          source_key?: string
          status?: string
          suite_version?: string
          updated_at?: string
          uploaded_at?: string
        }
        Relationships: []
      }
      web_search_cache: {
        Row: {
          cache_key: string
          created_at: string
          expires_at: string
          hit_count: number
          provider: string
          query: string
          response: Json
        }
        Insert: {
          cache_key: string
          created_at?: string
          expires_at: string
          hit_count?: number
          provider: string
          query: string
          response: Json
        }
        Update: {
          cache_key?: string
          created_at?: string
          expires_at?: string
          hit_count?: number
          provider?: string
          query?: string
          response?: Json
        }
        Relationships: []
      }
      workflow_runs: {
        Row: {
          confidence: number | null
          conversation_id: string
          created_at: string
          final_output: Json | null
          id: string
          status: string
          updated_at: string
          user_input: Json
          workflow_name: string
        }
        Insert: {
          confidence?: number | null
          conversation_id: string
          created_at?: string
          final_output?: Json | null
          id?: string
          status: string
          updated_at?: string
          user_input?: Json
          workflow_name: string
        }
        Update: {
          confidence?: number | null
          conversation_id?: string
          created_at?: string
          final_output?: Json | null
          id?: string
          status?: string
          updated_at?: string
          user_input?: Json
          workflow_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_runs_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_steps: {
        Row: {
          completed_at: string | null
          error: Json | null
          id: string
          input: Json | null
          output: Json | null
          started_at: string
          status: string
          step_name: string
          workflow_run_id: string
        }
        Insert: {
          completed_at?: string | null
          error?: Json | null
          id?: string
          input?: Json | null
          output?: Json | null
          started_at?: string
          status: string
          step_name: string
          workflow_run_id: string
        }
        Update: {
          completed_at?: string | null
          error?: Json | null
          id?: string
          input?: Json | null
          output?: Json | null
          started_at?: string
          status?: string
          step_name?: string
          workflow_run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_steps_workflow_run_id_fkey"
            columns: ["workflow_run_id"]
            isOneToOne: false
            referencedRelation: "workflow_runs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      latest_failed_test_result_items: {
        Row: {
          created_at: string | null
          elapsed_ms: number | null
          error_message: string | null
          id: string | null
          item_row_index: number | null
          passed: boolean | null
          prompt: string | null
          prompt_category: string | null
          response_payload: Json | null
          response_text: string | null
          row_index: number | null
          run_created_at: string | null
          status: string | null
          test_id: string | null
          test_item_id: string | null
          test_name: string | null
          test_result_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "test_items_test_id_fkey"
            columns: ["test_id"]
            isOneToOne: false
            referencedRelation: "tests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "test_result_items_test_item_id_fkey"
            columns: ["test_item_id"]
            isOneToOne: false
            referencedRelation: "test_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "test_result_items_test_result_id_fkey"
            columns: ["test_result_id"]
            isOneToOne: false
            referencedRelation: "test_results"
            referencedColumns: ["id"]
          },
        ]
      }
      orphan_checks_v: {
        Row: {
          check_key: string | null
          data_type: string | null
          detail: Json | null
          ref_id: string | null
          ref_label: string | null
        }
        Relationships: []
      }
      orphan_queue_v: {
        Row: {
          check_key: string | null
          data_type: string | null
          detail: Json | null
          ignore_reason: string | null
          ignored: boolean | null
          ignored_at: string | null
          ignored_by: string | null
          ref_id: string | null
          ref_label: string | null
        }
        Relationships: []
      }
      orphan_queue_summary_v: {
        Row: {
          active: number | null
          check_key: string | null
          data_type: string | null
          ignored: number | null
          total: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      admin_latest_failures_count: {
        Args: { p_search: string }
        Returns: number
      }
      admin_latest_failures_page: {
        Args: { p_limit: number; p_offset: number; p_search: string }
        Returns: {
          created_at: string | null
          elapsed_ms: number | null
          error_message: string | null
          id: string | null
          item_row_index: number | null
          passed: boolean | null
          prompt: string | null
          prompt_category: string | null
          response_payload: Json | null
          response_text: string | null
          row_index: number | null
          run_created_at: string | null
          status: string | null
          test_id: string | null
          test_item_id: string | null
          test_name: string | null
          test_result_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "latest_failed_test_result_items"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      classify_prompt_category: { Args: { p_prompt: string }; Returns: string }
      set_orphan_ignore: {
        Args: {
          p_check_key: string
          p_created_by?: string | null
          p_is_active?: boolean
          p_reason?: string | null
          p_ref_id: string
        }
        Returns: {
          check_key: string
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          reason: string | null
          ref_id: string
          updated_at: string
        }
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
