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
        let mut null_schema = SchemaObject::default();
        null_schema.instance_type = Some(InstanceType::Null.into());

        let mut schema = SchemaObject::default();
        schema.subschemas = Some(Box::new(SubschemaValidation {
            any_of: Some(vec![
                generator.subschema_for::<T>(),
                Schema::Object(null_schema),
            ]),
            ..Default::default()
        }));
        Schema::Object(schema)
    }
}

pub(crate) struct UtcTimestamp;

impl JsonSchema for UtcTimestamp {
    fn schema_name() -> String {
        "UtcTimestamp".to_owned()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        let mut schema = SchemaObject::default();
        schema.instance_type = Some(InstanceType::String.into());
        schema.format = Some("date-time".to_owned());
        Schema::Object(schema)
    }
}

pub(crate) struct False;

impl JsonSchema for False {
    fn schema_name() -> String {
        "False".to_owned()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        let mut schema = SchemaObject::default();
        schema.instance_type = Some(InstanceType::Boolean.into());
        schema.enum_values = Some(vec![false.into()]);
        Schema::Object(schema)
    }
}

pub(crate) struct AttributeMap;

impl JsonSchema for AttributeMap {
    fn schema_name() -> String {
        "AttributeMap".to_owned()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut property_name = SchemaObject::default();
        property_name.instance_type = Some(InstanceType::String.into());
        property_name.string = Some(Box::new(StringValidation {
            min_length: Some(1),
            max_length: Some(128),
            ..Default::default()
        }));

        let mut object = ObjectValidation::default();
        object.property_names = Some(Box::new(Schema::Object(property_name)));
        object.additional_properties = Some(Box::new(
            generator.subschema_for::<crate::document::Scalar>(),
        ));

        let mut schema = SchemaObject::default();
        schema.instance_type = Some(InstanceType::Object.into());
        schema.object = Some(Box::new(object));
        Schema::Object(schema)
    }
}
