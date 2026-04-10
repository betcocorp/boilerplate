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
  legacy: {
    Tables: {
      certifications: {
        Row: {
          CertificationsID: string | null
          Description: string | null
          ImageLink: string | null
        }
        Insert: {
          CertificationsID?: string | null
          Description?: string | null
          ImageLink?: string | null
        }
        Update: {
          CertificationsID?: string | null
          Description?: string | null
          ImageLink?: string | null
        }
        Relationships: []
      }
      competitor: {
        Row: {
          Competitor: string | null
          CompetitorID: number | null
          timestamp: string | null
        }
        Insert: {
          Competitor?: string | null
          CompetitorID?: number | null
          timestamp?: string | null
        }
        Update: {
          Competitor?: string | null
          CompetitorID?: number | null
          timestamp?: string | null
        }
        Relationships: []
      }
      competitor_products: {
        Row: {
          BetcoProdID: number | null
          Competitor: string | null
          id: string | null
          ProductDescr: string | null
          ProductID: number | null
          ProductKey: string | null
          timestamp: string | null
        }
        Insert: {
          BetcoProdID?: number | null
          Competitor?: string | null
          id?: string | null
          ProductDescr?: string | null
          ProductID?: number | null
          ProductKey?: string | null
          timestamp?: string | null
        }
        Update: {
          BetcoProdID?: number | null
          Competitor?: string | null
          id?: string | null
          ProductDescr?: string | null
          ProductID?: number | null
          ProductKey?: string | null
          timestamp?: string | null
        }
        Relationships: []
      }
      documents: {
        Row: {
          DocDescr: string | null
          DocTypesKey: string | null
          DocumentImage: string | null
          DocumentsKey: string | null
          FileName: string | null
          LanguageKey: string | null
          LinkName: string | null
          Location: string | null
          Sequence: number | null
          User_DTm_00: string | null
          User_DTm_01: string | null
          User_Flt_00: number | null
          User_Flt_01: number | null
          User_Int_00: number | null
          User_Int_01: number | null
        }
        Insert: {
          DocDescr?: string | null
          DocTypesKey?: string | null
          DocumentImage?: string | null
          DocumentsKey?: string | null
          FileName?: string | null
          LanguageKey?: string | null
          LinkName?: string | null
          Location?: string | null
          Sequence?: number | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
        }
        Update: {
          DocDescr?: string | null
          DocTypesKey?: string | null
          DocumentImage?: string | null
          DocumentsKey?: string | null
          FileName?: string | null
          LanguageKey?: string | null
          LinkName?: string | null
          Location?: string | null
          Sequence?: number | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
        }
        Relationships: []
      }
      feature_srch: {
        Row: {
          FeatureMstrDescr: string | null
          FeatureSrchKey: string | null
          SEQ: number | null
          User_DTm_00: string | null
          User_DTm_01: string | null
          User_Flt_00: number | null
          User_Flt_01: number | null
          User_Int_00: number | null
          User_Int_01: number | null
          User_Str_00: string | null
          User_Str_01: string | null
        }
        Insert: {
          FeatureMstrDescr?: string | null
          FeatureSrchKey?: string | null
          SEQ?: number | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
        }
        Update: {
          FeatureMstrDescr?: string | null
          FeatureSrchKey?: string | null
          SEQ?: number | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
        }
        Relationships: []
      }
      prod_class: {
        Row: {
          DSLProdClassDescr: string | null
          ProdClassID: string | null
          ProdClassKey: string | null
          User_DTm_00: string | null
          User_DTm_01: string | null
          User_Flt_00: number | null
          User_Flt_01: number | null
          User_Int_00: number | null
          User_Int_01: number | null
          User_Str_00: string | null
          User_Str_01: string | null
        }
        Insert: {
          DSLProdClassDescr?: string | null
          ProdClassID?: string | null
          ProdClassKey?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
        }
        Update: {
          DSLProdClassDescr?: string | null
          ProdClassID?: string | null
          ProdClassKey?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
        }
        Relationships: []
      }
      prod_images: {
        Row: {
          Filename: string | null
          ImageDescr: string | null
          ImageLink: string | null
          ImageName: string | null
          ImageSize: string | null
          ImageType: string | null
          ProdImagesKey: string | null
          ProductsKey: string | null
          Sequence: number | null
          User_DTm_00: string | null
          User_DTm_01: string | null
          User_Flt_00: number | null
          User_Flt_01: number | null
          User_Int_00: number | null
          User_Int_01: number | null
        }
        Insert: {
          Filename?: string | null
          ImageDescr?: string | null
          ImageLink?: string | null
          ImageName?: string | null
          ImageSize?: string | null
          ImageType?: string | null
          ProdImagesKey?: string | null
          ProductsKey?: string | null
          Sequence?: number | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
        }
        Update: {
          Filename?: string | null
          ImageDescr?: string | null
          ImageLink?: string | null
          ImageName?: string | null
          ImageSize?: string | null
          ImageType?: string | null
          ProdImagesKey?: string | null
          ProductsKey?: string | null
          Sequence?: number | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
        }
        Relationships: []
      }
      prod_line: {
        Row: {
          Applications: string | null
          H1: string | null
          H2: string | null
          MetaDescription: string | null
          MetaKeyWords: string | null
          ProdLineDescr: string | null
          ProdLineID: string | null
          ProdLineKey: string | null
          Title: string | null
          User_DTm_00: string | null
          User_DTm_01: string | null
          User_Flt_00: number | null
          User_Flt_01: number | null
          User_Int_00: number | null
          User_Int_01: number | null
          User_Str_00: string | null
          User_Str_01: string | null
          User_Str_02: string | null
          User_Str_03: string | null
          User_Str_04: string | null
          User_Str_05: string | null
        }
        Insert: {
          Applications?: string | null
          H1?: string | null
          H2?: string | null
          MetaDescription?: string | null
          MetaKeyWords?: string | null
          ProdLineDescr?: string | null
          ProdLineID?: string | null
          ProdLineKey?: string | null
          Title?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
          User_Str_02?: string | null
          User_Str_03?: string | null
          User_Str_04?: string | null
          User_Str_05?: string | null
        }
        Update: {
          Applications?: string | null
          H1?: string | null
          H2?: string | null
          MetaDescription?: string | null
          MetaKeyWords?: string | null
          ProdLineDescr?: string | null
          ProdLineID?: string | null
          ProdLineKey?: string | null
          Title?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
          User_Str_02?: string | null
          User_Str_03?: string | null
          User_Str_04?: string | null
          User_Str_05?: string | null
        }
        Relationships: []
      }
      prod_line_attr: {
        Row: {
          AttrKey: string | null
          AttrTable: string | null
          ProdLineKey: string | null
        }
        Insert: {
          AttrKey?: string | null
          AttrTable?: string | null
          ProdLineKey?: string | null
        }
        Update: {
          AttrKey?: string | null
          AttrTable?: string | null
          ProdLineKey?: string | null
        }
        Relationships: []
      }
      prod_line_descr: {
        Row: {
          FullDescr: string | null
          LanguageCD: string | null
          LanguageKey: string | null
          ProdLineDescrKey: string | null
          ProdLineKey: string | null
          ShortDescr: string | null
          User_DTm_00: string | null
          User_DTm_01: string | null
          User_Flt_00: number | null
          User_Flt_01: number | null
          User_Int_00: number | null
          User_Int_01: number | null
          User_Str_00: string | null
          User_Str_01: string | null
          User_Str_02: string | null
          User_Str_03: string | null
        }
        Insert: {
          FullDescr?: string | null
          LanguageCD?: string | null
          LanguageKey?: string | null
          ProdLineDescrKey?: string | null
          ProdLineKey?: string | null
          ShortDescr?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
          User_Str_02?: string | null
          User_Str_03?: string | null
        }
        Update: {
          FullDescr?: string | null
          LanguageCD?: string | null
          LanguageKey?: string | null
          ProdLineDescrKey?: string | null
          ProdLineKey?: string | null
          ShortDescr?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
          User_Str_02?: string | null
          User_Str_03?: string | null
        }
        Relationships: []
      }
      prod_types: {
        Row: {
          MstrDescr: string | null
          ProdTypesKey: string | null
          User_DTm_00: string | null
          User_DTm_01: string | null
          User_Flt_00: number | null
          User_Flt_01: number | null
          User_Int_00: number | null
          User_Int_01: number | null
          User_Str_00: string | null
          User_Str_01: string | null
        }
        Insert: {
          MstrDescr?: string | null
          ProdTypesKey?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
        }
        Update: {
          MstrDescr?: string | null
          ProdTypesKey?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
        }
        Relationships: []
      }
      product_direction_of_use: {
        Row: {
          Directions: string | null
          ProductDirectionOfUseKey: string | null
          Sequence: number | null
          User_DTm_00: string | null
          User_DTm_01: string | null
          User_Flt_00: number | null
          User_Flt_01: number | null
          User_Int_00: number | null
          User_Int_01: number | null
          User_Str_00: string | null
          User_Str_01: string | null
          User_Var_00: string | null
          User_Var_01: string | null
        }
        Insert: {
          Directions?: string | null
          ProductDirectionOfUseKey?: string | null
          Sequence?: number | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
          User_Var_00?: string | null
          User_Var_01?: string | null
        }
        Update: {
          Directions?: string | null
          ProductDirectionOfUseKey?: string | null
          Sequence?: number | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
          User_Var_00?: string | null
          User_Var_01?: string | null
        }
        Relationships: []
      }
      products: {
        Row: {
          Coats: number | null
          Coverage_CS: number | null
          Coverage_Usable_Gal_Sq_Ft: string | null
          DilutionCode: string | null
          DSLProdLn: string | null
          Gal_CS: number | null
          H1: string | null
          H2: string | null
          InvtID: string | null
          MetaDescription: string | null
          MetaKeyWords: string | null
          MSRP: number | null
          OnBuilders: string | null
          OnWeb: string | null
          ProductsKey: string | null
          SKU: string | null
          SLDescr: string | null
          SODate: string | null
          Status: string | null
          StkWt: string | null
          Title: string | null
          User_DTm_00: string | null
          User_DTm_01: string | null
          User_DTm_02: string | null
          User_DTm_03: string | null
          User_DTm_04: string | null
          User_Flt_00: number | null
          User_Flt_01: number | null
          User_Flt_02: number | null
          User_Flt_03: number | null
          User_Flt_04: number | null
          User_Int_02: number | null
          User_Int_03: number | null
          User_Int_04: number | null
          User_Str_00: string | null
          User_Str_01: string | null
          User_Str_02: string | null
          User_Str_03: string | null
          User_Str_04: string | null
          User_Str_05: string | null
          User_Str_06: string | null
          User_Str_07: string | null
          User_Str_08: string | null
          User_Str_09: string | null
          User_Str_10: string | null
          User_Str_11: string | null
          User_Str_12: string | null
          User_Str_13: string | null
          User_Str_14: string | null
          User_Str_15: string | null
          User_Str_16: string | null
          User_Str_17: string | null
          User_Str_18: string | null
          User_Str_19: string | null
          User_Str_20: string | null
          User_Str_21: string | null
          User_Str_22: string | null
          User_Str_23: string | null
          User_Str_24: string | null
          User_Str_25: string | null
          WtUOM: string | null
          YearsOfService: string | null
        }
        Insert: {
          Coats?: number | null
          Coverage_CS?: number | null
          Coverage_Usable_Gal_Sq_Ft?: string | null
          DilutionCode?: string | null
          DSLProdLn?: string | null
          Gal_CS?: number | null
          H1?: string | null
          H2?: string | null
          InvtID?: string | null
          MetaDescription?: string | null
          MetaKeyWords?: string | null
          MSRP?: number | null
          OnBuilders?: string | null
          OnWeb?: string | null
          ProductsKey?: string | null
          SKU?: string | null
          SLDescr?: string | null
          SODate?: string | null
          Status?: string | null
          StkWt?: string | null
          Title?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_DTm_02?: string | null
          User_DTm_03?: string | null
          User_DTm_04?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Flt_02?: number | null
          User_Flt_03?: number | null
          User_Flt_04?: number | null
          User_Int_02?: number | null
          User_Int_03?: number | null
          User_Int_04?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
          User_Str_02?: string | null
          User_Str_03?: string | null
          User_Str_04?: string | null
          User_Str_05?: string | null
          User_Str_06?: string | null
          User_Str_07?: string | null
          User_Str_08?: string | null
          User_Str_09?: string | null
          User_Str_10?: string | null
          User_Str_11?: string | null
          User_Str_12?: string | null
          User_Str_13?: string | null
          User_Str_14?: string | null
          User_Str_15?: string | null
          User_Str_16?: string | null
          User_Str_17?: string | null
          User_Str_18?: string | null
          User_Str_19?: string | null
          User_Str_20?: string | null
          User_Str_21?: string | null
          User_Str_22?: string | null
          User_Str_23?: string | null
          User_Str_24?: string | null
          User_Str_25?: string | null
          WtUOM?: string | null
          YearsOfService?: string | null
        }
        Update: {
          Coats?: number | null
          Coverage_CS?: number | null
          Coverage_Usable_Gal_Sq_Ft?: string | null
          DilutionCode?: string | null
          DSLProdLn?: string | null
          Gal_CS?: number | null
          H1?: string | null
          H2?: string | null
          InvtID?: string | null
          MetaDescription?: string | null
          MetaKeyWords?: string | null
          MSRP?: number | null
          OnBuilders?: string | null
          OnWeb?: string | null
          ProductsKey?: string | null
          SKU?: string | null
          SLDescr?: string | null
          SODate?: string | null
          Status?: string | null
          StkWt?: string | null
          Title?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_DTm_02?: string | null
          User_DTm_03?: string | null
          User_DTm_04?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Flt_02?: number | null
          User_Flt_03?: number | null
          User_Flt_04?: number | null
          User_Int_02?: number | null
          User_Int_03?: number | null
          User_Int_04?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
          User_Str_02?: string | null
          User_Str_03?: string | null
          User_Str_04?: string | null
          User_Str_05?: string | null
          User_Str_06?: string | null
          User_Str_07?: string | null
          User_Str_08?: string | null
          User_Str_09?: string | null
          User_Str_10?: string | null
          User_Str_11?: string | null
          User_Str_12?: string | null
          User_Str_13?: string | null
          User_Str_14?: string | null
          User_Str_15?: string | null
          User_Str_16?: string | null
          User_Str_17?: string | null
          User_Str_18?: string | null
          User_Str_19?: string | null
          User_Str_20?: string | null
          User_Str_21?: string | null
          User_Str_22?: string | null
          User_Str_23?: string | null
          User_Str_24?: string | null
          User_Str_25?: string | null
          WtUOM?: string | null
          YearsOfService?: string | null
        }
        Relationships: []
      }
      products_attr: {
        Row: {
          AttrKey: string | null
          AttrTable: string | null
          ProductsKey: string | null
        }
        Insert: {
          AttrKey?: string | null
          AttrTable?: string | null
          ProductsKey?: string | null
        }
        Update: {
          AttrKey?: string | null
          AttrTable?: string | null
          ProductsKey?: string | null
        }
        Relationships: []
      }
      products_descr: {
        Row: {
          FullDescr: string | null
          LanguageCD: string | null
          LanguageKey: string | null
          ProductsDescrKey: string | null
          ProductsKey: string | null
          ShortDescr: string | null
          User_DTm_00: string | null
          User_DTm_01: string | null
          User_Flt_00: number | null
          User_Flt_01: number | null
          User_Int_00: number | null
          User_Int_01: number | null
          User_Str_00: string | null
          User_Str_01: string | null
          User_Str_02: string | null
          User_Str_03: string | null
        }
        Insert: {
          FullDescr?: string | null
          LanguageCD?: string | null
          LanguageKey?: string | null
          ProductsDescrKey?: string | null
          ProductsKey?: string | null
          ShortDescr?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
          User_Str_02?: string | null
          User_Str_03?: string | null
        }
        Update: {
          FullDescr?: string | null
          LanguageCD?: string | null
          LanguageKey?: string | null
          ProductsDescrKey?: string | null
          ProductsKey?: string | null
          ShortDescr?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
          User_Str_02?: string | null
          User_Str_03?: string | null
        }
        Relationships: []
      }
      related_products: {
        Row: {
          RelatedKey: string | null
          RelatedTable: string | null
          SourceKey: string | null
          SourceTable: string | null
        }
        Insert: {
          RelatedKey?: string | null
          RelatedTable?: string | null
          SourceKey?: string | null
          SourceTable?: string | null
        }
        Update: {
          RelatedKey?: string | null
          RelatedTable?: string | null
          SourceKey?: string | null
          SourceTable?: string | null
        }
        Relationships: []
      }
      size_code: {
        Row: {
          D2Code: string | null
          D3Code: string | null
          SizeCodeKey: string | null
          User_DTm_00: string | null
          User_DTm_01: string | null
          User_Flt_00: number | null
          User_Flt_01: number | null
          User_Int_00: number | null
          User_Int_01: number | null
          User_Str_00: string | null
          User_Str_01: string | null
        }
        Insert: {
          D2Code?: string | null
          D3Code?: string | null
          SizeCodeKey?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
        }
        Update: {
          D2Code?: string | null
          D3Code?: string | null
          SizeCodeKey?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
        }
        Relationships: []
      }
      size_code_descr: {
        Row: {
          LanguageCD: string | null
          LanguageKey: string | null
          SizeCodeDescrKey: string | null
          SizeCodeKey: string | null
          SizeDescr: string | null
        }
        Insert: {
          LanguageCD?: string | null
          LanguageKey?: string | null
          SizeCodeDescrKey?: string | null
          SizeCodeKey?: string | null
          SizeDescr?: string | null
        }
        Update: {
          LanguageCD?: string | null
          LanguageKey?: string | null
          SizeCodeDescrKey?: string | null
          SizeCodeKey?: string | null
          SizeDescr?: string | null
        }
        Relationships: []
      }
      sub_child_prod_types: {
        Row: {
          MstrDescr: string | null
          SubChildProdTypesKey: string | null
          SubProdTypesKey: string | null
          User_DTm_00: string | null
          User_DTm_01: string | null
          User_Flt_00: number | null
          User_Flt_01: number | null
          User_Int_00: number | null
          User_Int_01: number | null
          User_Str_00: string | null
          User_Str_01: string | null
        }
        Insert: {
          MstrDescr?: string | null
          SubChildProdTypesKey?: string | null
          SubProdTypesKey?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
        }
        Update: {
          MstrDescr?: string | null
          SubChildProdTypesKey?: string | null
          SubProdTypesKey?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
        }
        Relationships: []
      }
      sub_child_prod_types_descr: {
        Row: {
          FullDescr: string | null
          LanguageKey: string | null
          ShortDescr: string | null
          SubChildProdTypesDescrKey: string | null
          SubChildProdTypesKey: string | null
          User_DTm_00: string | null
          User_DTm_01: string | null
          User_Flt_00: number | null
          User_Flt_01: number | null
          User_Int_00: number | null
          User_Int_01: number | null
          User_Str_00: string | null
          User_Str_01: string | null
          User_Str_02: string | null
          User_Str_03: string | null
        }
        Insert: {
          FullDescr?: string | null
          LanguageKey?: string | null
          ShortDescr?: string | null
          SubChildProdTypesDescrKey?: string | null
          SubChildProdTypesKey?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
          User_Str_02?: string | null
          User_Str_03?: string | null
        }
        Update: {
          FullDescr?: string | null
          LanguageKey?: string | null
          ShortDescr?: string | null
          SubChildProdTypesDescrKey?: string | null
          SubChildProdTypesKey?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
          User_Str_02?: string | null
          User_Str_03?: string | null
        }
        Relationships: []
      }
      sub_prod_types: {
        Row: {
          MstrDescr: string | null
          ProdTypesKey: string | null
          SubProdTypesKey: string | null
          User_DTm_00: string | null
          User_DTm_01: string | null
          User_Flt_00: number | null
          User_Flt_01: number | null
          User_Int_00: number | null
          User_Int_01: number | null
          User_Str_00: string | null
          User_Str_01: string | null
        }
        Insert: {
          MstrDescr?: string | null
          ProdTypesKey?: string | null
          SubProdTypesKey?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
        }
        Update: {
          MstrDescr?: string | null
          ProdTypesKey?: string | null
          SubProdTypesKey?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
        }
        Relationships: []
      }
      sub_prod_types_descr: {
        Row: {
          FullDescr: string | null
          LanguageKey: string | null
          ShortDescr: string | null
          SubProdTypesDescrKey: string | null
          SubProdTypesKey: string | null
          User_DTm_00: string | null
          User_DTm_01: string | null
          User_Flt_00: number | null
          User_Flt_01: number | null
          User_Int_00: number | null
          User_Int_01: number | null
          User_Str_00: string | null
          User_Str_01: string | null
          User_Str_02: string | null
          User_Str_03: string | null
        }
        Insert: {
          FullDescr?: string | null
          LanguageKey?: string | null
          ShortDescr?: string | null
          SubProdTypesDescrKey?: string | null
          SubProdTypesKey?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
          User_Str_02?: string | null
          User_Str_03?: string | null
        }
        Update: {
          FullDescr?: string | null
          LanguageKey?: string | null
          ShortDescr?: string | null
          SubProdTypesDescrKey?: string | null
          SubProdTypesKey?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
          User_Str_02?: string | null
          User_Str_03?: string | null
        }
        Relationships: []
      }
      tech_spec: {
        Row: {
          SortOrder: number | null
          TechSpecDefKey: string | null
          TechSpecKey: string | null
          TechValue: string | null
          User_DTm_00: string | null
          User_DTm_01: string | null
          User_Flt_00: number | null
          User_Flt_01: number | null
          User_Int_01: number | null
          User_Str_00: string | null
          User_Str_01: string | null
        }
        Insert: {
          SortOrder?: number | null
          TechSpecDefKey?: string | null
          TechSpecKey?: string | null
          TechValue?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
        }
        Update: {
          SortOrder?: number | null
          TechSpecDefKey?: string | null
          TechSpecKey?: string | null
          TechValue?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
        }
        Relationships: []
      }
      tech_spec_def: {
        Row: {
          TechSpecDef: string | null
          TechSpecDefKey: string | null
          User_DTm_00: string | null
          User_DTm_01: string | null
          User_Flt_00: number | null
          User_Flt_01: number | null
          User_Int_00: number | null
          User_Int_01: number | null
          User_Str_00: string | null
          User_Str_01: string | null
          User_Str_02: string | null
          User_Str_03: string | null
        }
        Insert: {
          TechSpecDef?: string | null
          TechSpecDefKey?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
          User_Str_02?: string | null
          User_Str_03?: string | null
        }
        Update: {
          TechSpecDef?: string | null
          TechSpecDefKey?: string | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_00?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
          User_Str_02?: string | null
          User_Str_03?: string | null
        }
        Relationships: []
      }
      videos: {
        Row: {
          SortOrder: number | null
          User_DTm_00: string | null
          User_DTm_01: string | null
          User_Flt_00: number | null
          User_Flt_01: number | null
          User_Int_01: number | null
          User_Str_00: string | null
          User_Str_01: string | null
          VideoDescr: string | null
          VideoLoc: string | null
          VideosKey: string | null
        }
        Insert: {
          SortOrder?: number | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
          VideoDescr?: string | null
          VideoLoc?: string | null
          VideosKey?: string | null
        }
        Update: {
          SortOrder?: number | null
          User_DTm_00?: string | null
          User_DTm_01?: string | null
          User_Flt_00?: number | null
          User_Flt_01?: number | null
          User_Int_01?: number | null
          User_Str_00?: string | null
          User_Str_01?: string | null
          VideoDescr?: string | null
          VideoLoc?: string | null
          VideosKey?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
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
  legacy: {
    Enums: {},
  },
} as const
