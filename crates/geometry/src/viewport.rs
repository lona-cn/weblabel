use annotation_domain::DomainError;

/// Image-to-CSS view state. DPR describes the backing store only; it never
/// participates in persistent image coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Viewport {
    pub scale: f64,
    pub tx: f64,
    pub ty: f64,
    pub css_width: f64,
    pub css_height: f64,
    pub dpr: f64,
}

impl Viewport {
    pub fn try_new(
        scale: f64,
        tx: f64,
        ty: f64,
        css_width: f64,
        css_height: f64,
        dpr: f64,
    ) -> Result<Self, DomainError> {
        let view = Self {
            scale,
            tx,
            ty,
            css_width,
            css_height,
            dpr,
        };
        view.validate()?;
        Ok(view)
    }

    pub fn validate(self) -> Result<(), DomainError> {
        if !self.scale.is_finite() || self.scale <= 0.0 {
            return Err(DomainError::new(
                "INVALID_VIEWPORT",
                "scale must be finite and positive",
            ));
        }
        if !self.tx.is_finite() || !self.ty.is_finite() {
            return Err(DomainError::new(
                "INVALID_VIEWPORT",
                "translation must be finite",
            ));
        }
        if !self.css_width.is_finite()
            || !self.css_height.is_finite()
            || self.css_width < 0.0
            || self.css_height < 0.0
        {
            return Err(DomainError::new(
                "INVALID_VIEWPORT",
                "CSS dimensions must be finite and non-negative",
            ));
        }
        if !self.dpr.is_finite() || self.dpr <= 0.0 {
            return Err(DomainError::new(
                "INVALID_VIEWPORT",
                "device pixel ratio must be finite and positive",
            ));
        }
        Ok(())
    }
}

#[inline]
pub fn image_to_css(point: [f64; 2], view: Viewport) -> [f64; 2] {
    [
        point[0] * view.scale + view.tx,
        point[1] * view.scale + view.ty,
    ]
}

#[inline]
pub fn css_to_image(point: [f64; 2], view: Viewport) -> [f64; 2] {
    [
        (point[0] - view.tx) / view.scale,
        (point[1] - view.ty) / view.scale,
    ]
}

/// Changes magnification while keeping the image location under `css` fixed.
pub fn zoom_anchor(view: Viewport, css: [f64; 2], factor: f64) -> Result<Viewport, DomainError> {
    view.validate()?;
    if !css[0].is_finite() || !css[1].is_finite() || !factor.is_finite() || factor <= 0.0 {
        return Err(DomainError::new(
            "INVALID_VIEWPORT",
            "zoom anchor and factor must be finite; factor must be positive",
        ));
    }
    let image = css_to_image(css, view);
    let scale = view.scale * factor;
    if !scale.is_finite() || scale <= 0.0 {
        return Err(DomainError::new(
            "INVALID_VIEWPORT",
            "zoomed scale must be finite and positive",
        ));
    }
    let next = Viewport {
        scale,
        tx: css[0] - image[0] * scale,
        ty: css[1] - image[1] * scale,
        ..view
    };
    next.validate()?;
    Ok(next)
}
