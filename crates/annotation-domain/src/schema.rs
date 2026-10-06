use std::marker::PhantomData;

use schemars::{
    schema::{
        InstanceType, ObjectValidation, Schema, SchemaObject, StringValidation, SubschemaValidation,
    },
    JsonSchema, SchemaGenerator,
};

pub(crate) struct Nullable<T>(PhantomData<T>);

impl<T: JsonSchema> JsonSchema for Nullable<T> {
    fn schema_name() -> String {
        format!("Nullable_{}", T::schema_name())
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let null_schema = SchemaObject {
            instance_type: Some(InstanceType::Null.into()),
            ..Default::default()
        };
        Schema::Object(SchemaObject {
            subschemas: Some(Box::new(SubschemaValidation {
                any_of: Some(vec![
                    generator.subschema_for::<T>(),
                    Schema::Object(null_schema),
                ]),
                ..Default::default()
            })),
            ..Default::default()
        })
    }
}

pub(crate) struct UtcTimestamp;

impl JsonSchema for UtcTimestamp {
    fn schema_name() -> String {
        "UtcTimestamp".to_owned()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        Schema::Object(SchemaObject {
            instance_type: Some(InstanceType::String.into()),
            format: Some("date-time".to_owned()),
            ..Default::default()
        })
    }
}

pub(crate) struct False;

impl JsonSchema for False {
    fn schema_name() -> String {
        "False".to_owned()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        Schema::Object(SchemaObject {
            instance_type: Some(InstanceType::Boolean.into()),
            enum_values: Some(vec![false.into()]),
            ..Default::default()
        })
    }
}

pub(crate) struct AttributeMap;

impl JsonSchema for AttributeMap {
    fn schema_name() -> String {
        "AttributeMap".to_owned()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let property_name = SchemaObject {
            instance_type: Some(InstanceType::String.into()),
            string: Some(Box::new(StringValidation {
                min_length: Some(1),
                max_length: Some(128),
                ..Default::default()
            })),
            ..Default::default()
        };
        Schema::Object(SchemaObject {
            instance_type: Some(InstanceType::Object.into()),
            object: Some(Box::new(ObjectValidation {
                property_names: Some(Box::new(Schema::Object(property_name))),
                additional_properties: Some(Box::new(
                    generator.subschema_for::<crate::document::Scalar>(),
                )),
                ..Default::default()
            })),
            ..Default::default()
        })
    }
}
