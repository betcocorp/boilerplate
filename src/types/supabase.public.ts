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
          completed_at: string | null
          created_at: string
          elapsed_ms: number | null
          failed_items: number
          id: string
          notes: string | null
          passed_items: number
          started_at: string
          status: string
          summary: Json
          test_id: string
          total_items: number
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          elapsed_ms?: number | null
          failed_items?: number
          id?: string
          notes?: string | null
          passed_items?: number
          started_at?: string
          status?: string
          summary?: Json
          test_id: string
          total_items?: number
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          elapsed_ms?: number | null
          failed_items?: number
          id?: string
          notes?: string | null
          passed_items?: number
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
          id: string
          intended_agent: string | null
          metadata: Json
          name: string
          row_count: number
          source_bucket: string
          source_file_name: string
          source_key: string
          status: string
          updated_at: string
          uploaded_at: string
        }
        Insert: {
          id?: string
          intended_agent?: string | null
          metadata?: Json
          name: string
          row_count?: number
          source_bucket: string
          source_file_name: string
          source_key: string
          status?: string
          updated_at?: string
          uploaded_at?: string
        }
        Update: {
          id?: string
          intended_agent?: string | null
          metadata?: Json
          name?: string
          row_count?: number
          source_bucket?: string
          source_file_name?: string
          source_key?: string
          status?: string
          updated_at?: string
          uploaded_at?: string
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
