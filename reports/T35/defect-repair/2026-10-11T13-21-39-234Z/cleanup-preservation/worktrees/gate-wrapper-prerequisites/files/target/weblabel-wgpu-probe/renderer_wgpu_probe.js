/* @ts-self-types="./renderer_wgpu_probe.d.ts" */

//#region exports

/**
 * Browser-backed renderer. No alternate canvas renderer is provided.
 */
export class Renderer {
    constructor() {
        throw new Error('cannot invoke `new` directly');
    }
    static __wrap(ptr) {
        const obj = Object.create(Renderer.prototype);
        obj.__wbg_ptr = ptr;
        RendererFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RendererFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_renderer_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    adapter_diagnostics() {
        let deferred1_0;
        let deferred1_1;
        try {
            if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
            _assertNum(this.__wbg_ptr);
            const ret = wasm.renderer_adapter_diagnostics(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Owned notification: waiting in JS never borrows this WASM object.
     * @returns {Promise<any>}
     */
    device_lost() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.renderer_device_lost(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string}
     */
    device_state() {
        let deferred1_0;
        let deferred1_1;
        try {
            if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
            _assertNum(this.__wbg_ptr);
            const ret = wasm.renderer_device_state(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    dispose() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        wasm.renderer_dispose(this.__wbg_ptr);
    }
    /**
     * @returns {boolean}
     */
    is_device_lost() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.renderer_is_device_lost(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {number} width
     * @param {number} height
     * @param {Uint8Array} rgba
     * @returns {Promise<Renderer>}
     */
    static new(canvas, width, height, rgba) {
        _assertNum(width);
        _assertNum(height);
        const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.renderer_new(canvas, width, height, ptr0, len0);
        return ret;
    }
    /**
     * @returns {Promise<void>}
     */
    recover() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.renderer_recover(this.__wbg_ptr);
        return ret;
    }
    render() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.renderer_render(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} css_width
     * @param {number} css_height
     * @param {number} dpr
     */
    resize(css_width, css_height, dpr) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.renderer_resize(this.__wbg_ptr, css_width, css_height, dpr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Update annotation geometry/overlays without retransferring the image.
     * @param {any} projection
     */
    update_objects(projection) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.renderer_update_objects(this.__wbg_ptr, projection);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Replace the complete renderer scene, including the canonical image.
     * Use the narrower update methods for ordinary viewport or object changes.
     * @param {any} scene
     */
    update_scene(scene) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.renderer_update_scene(this.__wbg_ptr, scene);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Update pan/zoom without transferring image pixels or rebuilding instances.
     * @param {any} viewport
     */
    update_viewport(viewport) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.renderer_update_viewport(this.__wbg_ptr, viewport);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) Renderer.prototype[Symbol.dispose] = Renderer.prototype.free;

/**
 * @returns {Promise<string>}
 */
export function initialize_browser_device_probe() {
    const ret = wasm.initialize_browser_device_probe();
    return ret;
}

//#endregion

//#region wasm imports
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_67e7344beaa85059: function() { return logError(function (arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        }, arguments); },
        __wbg_Number_c54e7112a3fa7e3e: function() { return logError(function (arg0) {
            const ret = Number(arg0);
            return ret;
        }, arguments); },
        __wbg_String_8564e559799eccda: function() { return logError(function (arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        }, arguments); },
        __wbg_Window_a2a6c4d665047b14: function() { return logError(function (arg0) {
            const ret = arg0.Window;
            return ret;
        }, arguments); },
        __wbg_WorkerGlobalScope_2664448a7c667d67: function() { return logError(function (arg0) {
            const ret = arg0.WorkerGlobalScope;
            return ret;
        }, arguments); },
        __wbg___wbindgen_boolean_get_7a12af2b3f899c5a: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            if (!isLikeNone(ret)) {
                _assertBoolean(ret);
            }
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_0e68cf47c9cbd9b0: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_in_50072d4d6e45c193: function(arg0, arg1) {
            const ret = arg0 in arg1;
            _assertBoolean(ret);
            return ret;
        },
        __wbg___wbindgen_is_function_fcda5e3902d732fe: function(arg0) {
            const ret = typeof(arg0) === 'function';
            _assertBoolean(ret);
            return ret;
        },
        __wbg___wbindgen_is_null_5160b3e381865372: function(arg0) {
            const ret = arg0 === null;
            _assertBoolean(ret);
            return ret;
        },
        __wbg___wbindgen_is_object_edb6b15aa3afe12e: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            _assertBoolean(ret);
            return ret;
        },
        __wbg___wbindgen_is_string_c4f7cb494a2a21f1: function(arg0) {
            const ret = typeof(arg0) === 'string';
            _assertBoolean(ret);
            return ret;
        },
        __wbg___wbindgen_is_undefined_8c687d0b90d5b524: function(arg0) {
            const ret = arg0 === undefined;
            _assertBoolean(ret);
            return ret;
        },
        __wbg___wbindgen_jsval_loose_eq_3c30021c243b64cd: function(arg0, arg1) {
            const ret = arg0 == arg1;
            _assertBoolean(ret);
            return ret;
        },
        __wbg___wbindgen_number_get_1dc732b810cb937c: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            if (!isLikeNone(ret)) {
                _assertNum(ret);
            }
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_92ab86bb19cbc12f: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_5d9e815e6fdf150f: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_997e73d32238e655: function() { return logError(function (arg0) {
            arg0._wbg_cb_unref();
        }, arguments); },
        __wbg_adapterInfo_f9744bfff61e772c: function() { return logError(function (arg0) {
            const ret = arg0.adapterInfo;
            return ret;
        }, arguments); },
        __wbg_architecture_774b38597921c3f9: function() { return logError(function (arg0, arg1) {
            const ret = arg1.architecture;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        }, arguments); },
        __wbg_beginComputePass_b9a325184985e6ff: function() { return logError(function (arg0, arg1) {
            const ret = arg0.beginComputePass(arg1);
            return ret;
        }, arguments); },
        __wbg_beginOcclusionQuery_f86da62bc2698f21: function() { return logError(function (arg0, arg1) {
            arg0.beginOcclusionQuery(arg1 >>> 0);
        }, arguments); },
        __wbg_beginRenderPass_3c53642423af50dc: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.beginRenderPass(arg1);
            return ret;
        }, arguments); },
        __wbg_call_269c5566fbede3eb: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_call_6bcf8d3e20937e46: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_clearBuffer_3d5a3057c3c8a9bf: function() { return logError(function (arg0, arg1, arg2, arg3) {
            arg0.clearBuffer(arg1, arg2, arg3);
        }, arguments); },
        __wbg_clearBuffer_82ba999c294f42fb: function() { return logError(function (arg0, arg1, arg2) {
            arg0.clearBuffer(arg1, arg2);
        }, arguments); },
        __wbg_clientHeight_8669994caeda015c: function() { return logError(function (arg0) {
            const ret = arg0.clientHeight;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_clientWidth_669677d957e958c7: function() { return logError(function (arg0) {
            const ret = arg0.clientWidth;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_configure_1e2c1c9edad07d26: function() { return handleError(function (arg0, arg1) {
            arg0.configure(arg1);
        }, arguments); },
        __wbg_copyBufferToBuffer_01766818654a9868: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            arg0.copyBufferToBuffer(arg1, arg2, arg3, arg4);
        }, arguments); },
        __wbg_copyBufferToBuffer_9c174b96fb08d551: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.copyBufferToBuffer(arg1, arg2, arg3, arg4, arg5);
        }, arguments); },
        __wbg_copyBufferToTexture_ff632a21ab3fe3a7: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            arg0.copyBufferToTexture(arg1, arg2, arg3);
        }, arguments); },
        __wbg_copyExternalImageToTexture_116560f3be856776: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            arg0.copyExternalImageToTexture(arg1, arg2, arg3);
        }, arguments); },
        __wbg_copyTextureToBuffer_1234b3210431ad05: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            arg0.copyTextureToBuffer(arg1, arg2, arg3);
        }, arguments); },
        __wbg_copyTextureToTexture_d2e6a1eb3254b828: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            arg0.copyTextureToTexture(arg1, arg2, arg3);
        }, arguments); },
        __wbg_createBindGroupLayout_b1bd63b4e88459d8: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.createBindGroupLayout(arg1);
            return ret;
        }, arguments); },
        __wbg_createBindGroup_f539b26ca341308f: function() { return logError(function (arg0, arg1) {
            const ret = arg0.createBindGroup(arg1);
            return ret;
        }, arguments); },
        __wbg_createBuffer_d800e9b1d41b2ee5: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.createBuffer(arg1);
            return ret;
        }, arguments); },
        __wbg_createCommandEncoder_3352d1ffc36c6fc0: function() { return logError(function (arg0, arg1) {
            const ret = arg0.createCommandEncoder(arg1);
            return ret;
        }, arguments); },
        __wbg_createComputePipeline_224fa2618d9948a0: function() { return logError(function (arg0, arg1) {
            const ret = arg0.createComputePipeline(arg1);
            return ret;
        }, arguments); },
        __wbg_createPipelineLayout_6eab52c327118937: function() { return logError(function (arg0, arg1) {
            const ret = arg0.createPipelineLayout(arg1);
            return ret;
        }, arguments); },
        __wbg_createQuerySet_2dc8cde53df9849d: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.createQuerySet(arg1);
            return ret;
        }, arguments); },
        __wbg_createRenderBundleEncoder_b043a947140f8b17: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.createRenderBundleEncoder(arg1);
            return ret;
        }, arguments); },
        __wbg_createRenderPipeline_0ebb7ebc653e9207: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.createRenderPipeline(arg1);
            return ret;
        }, arguments); },
        __wbg_createSampler_9bd91d7e928c0060: function() { return logError(function (arg0, arg1) {
            const ret = arg0.createSampler(arg1);
            return ret;
        }, arguments); },
        __wbg_createShaderModule_cefa51336cb288ae: function() { return logError(function (arg0, arg1) {
            const ret = arg0.createShaderModule(arg1);
            return ret;
        }, arguments); },
        __wbg_createTexture_ed7e9fc04dd54d84: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.createTexture(arg1);
            return ret;
        }, arguments); },
        __wbg_createView_da41c2d2cb212715: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.createView(arg1);
            return ret;
        }, arguments); },
        __wbg_description_83b8a393160021b9: function() { return logError(function (arg0, arg1) {
            const ret = arg1.description;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        }, arguments); },
        __wbg_destroy_249478e98a7943d5: function() { return logError(function (arg0) {
            arg0.destroy();
        }, arguments); },
        __wbg_destroy_275564a0a8b8d071: function() { return logError(function (arg0) {
            arg0.destroy();
        }, arguments); },
        __wbg_destroy_637537007d9eaa44: function() { return logError(function (arg0) {
            arg0.destroy();
        }, arguments); },
        __wbg_devicePixelRatio_da557bfb3b99fb02: function() { return logError(function (arg0) {
            const ret = arg0.devicePixelRatio;
            return ret;
        }, arguments); },
        __wbg_device_ea9f7c866aa1cbfb: function() { return logError(function (arg0, arg1) {
            const ret = arg1.device;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        }, arguments); },
        __wbg_document_c7f486c52d63d24e: function() { return logError(function (arg0) {
            const ret = arg0.document;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_done_cffed884d87aa22e: function() { return logError(function (arg0) {
            const ret = arg0.done;
            _assertBoolean(ret);
            return ret;
        }, arguments); },
        __wbg_drawIndexedIndirect_d01f2181b905a0b5: function() { return logError(function (arg0, arg1, arg2) {
            arg0.drawIndexedIndirect(arg1, arg2);
        }, arguments); },
        __wbg_drawIndexed_638959aae942557c: function() { return logError(function (arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.drawIndexed(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4, arg5 >>> 0);
        }, arguments); },
        __wbg_drawIndirect_269c8a4880a070c8: function() { return logError(function (arg0, arg1, arg2) {
            arg0.drawIndirect(arg1, arg2);
        }, arguments); },
        __wbg_draw_086a9578fc9898c2: function() { return logError(function (arg0, arg1, arg2, arg3, arg4) {
            arg0.draw(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
        }, arguments); },
        __wbg_endOcclusionQuery_357622c54ce0b5bb: function() { return logError(function (arg0) {
            arg0.endOcclusionQuery();
        }, arguments); },
        __wbg_end_b57473834b877409: function() { return logError(function (arg0) {
            arg0.end();
        }, arguments); },
        __wbg_error_8c8dff942c7c4f11: function() { return logError(function (arg0) {
            const ret = arg0.error;
            return ret;
        }, arguments); },
        __wbg_executeBundles_3fdfe6a4384e53a3: function() { return logError(function (arg0, arg1, arg2) {
            arg0.executeBundles(getArrayJsValueViewFromWasm0(arg1, arg2));
        }, arguments); },
        __wbg_features_5cac120c28ba0475: function() { return logError(function (arg0) {
            const ret = arg0.features;
            return ret;
        }, arguments); },
        __wbg_features_dec7bd2fd3d91bd6: function() { return logError(function (arg0) {
            const ret = arg0.features;
            return ret;
        }, arguments); },
        __wbg_finish_09ec094c10f41e7b: function() { return logError(function (arg0) {
            const ret = arg0.finish();
            return ret;
        }, arguments); },
        __wbg_finish_ec1c191f66a895b1: function() { return logError(function (arg0, arg1) {
            const ret = arg0.finish(arg1);
            return ret;
        }, arguments); },
        __wbg_getContext_5ff6bd600503b094: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.getContext(getStringFromWasm0(arg1, arg2));
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_getContext_e0c05ffee530bdcf: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.getContext(getStringFromWasm0(arg1, arg2));
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_getCurrentTexture_9f3b84d0eaa6cd95: function() { return handleError(function (arg0) {
            const ret = arg0.getCurrentTexture();
            return ret;
        }, arguments); },
        __wbg_getMappedRange_fb54c6327b2d8d20: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.getMappedRange(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_getPreferredCanvasFormat_0ef5034c8902201b: function() { return logError(function (arg0) {
            const ret = arg0.getPreferredCanvasFormat();
            return (__wbindgen_enum_GpuTextureFormat.indexOf(ret) + 1 || 102) - 1;
        }, arguments); },
        __wbg_get_6cf5a4d4d8ad3c5a: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_95e4d462165c92ae: function() { return logError(function (arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_get_unchecked_363572bdd397d473: function() { return logError(function (arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        }, arguments); },
        __wbg_get_with_ref_key_6412cf3094599694: function() { return logError(function (arg0, arg1) {
            const ret = arg0[arg1];
            return ret;
        }, arguments); },
        __wbg_gpu_afdd4387c7afe5f9: function() { return logError(function (arg0) {
            const ret = arg0.gpu;
            return ret;
        }, arguments); },
        __wbg_has_eafa12e457ea88fb: function() { return logError(function (arg0, arg1, arg2) {
            const ret = arg0.has(getStringFromWasm0(arg1, arg2));
            _assertBoolean(ret);
            return ret;
        }, arguments); },
        __wbg_info_971d8b9db3dae69f: function() { return logError(function (arg0) {
            const ret = arg0.info;
            return ret;
        }, arguments); },
        __wbg_insertDebugMarker_1b83135bb1c34c13: function() { return logError(function (arg0, arg1, arg2) {
            arg0.insertDebugMarker(getStringFromWasm0(arg1, arg2));
        }, arguments); },
        __wbg_insertDebugMarker_9ab854feedaf4b8d: function() { return logError(function (arg0, arg1, arg2) {
            arg0.insertDebugMarker(getStringFromWasm0(arg1, arg2));
        }, arguments); },
        __wbg_instanceof_ArrayBuffer_d4ff01f8247925ae: function() { return logError(function (arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            _assertBoolean(ret);
            return ret;
        }, arguments); },
        __wbg_instanceof_GpuOutOfMemoryError_5c3b8a2499f59adb: function() { return logError(function (arg0) {
            let result;
            try {
                result = arg0 instanceof GPUOutOfMemoryError;
            } catch (_) {
                result = false;
            }
            const ret = result;
            _assertBoolean(ret);
            return ret;
        }, arguments); },
        __wbg_instanceof_GpuValidationError_7659e07b12d4e184: function() { return logError(function (arg0) {
            let result;
            try {
                result = arg0 instanceof GPUValidationError;
            } catch (_) {
                result = false;
            }
            const ret = result;
            _assertBoolean(ret);
            return ret;
        }, arguments); },
        __wbg_instanceof_Uint8Array_598adc0fef426aa8: function() { return logError(function (arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            _assertBoolean(ret);
            return ret;
        }, arguments); },
        __wbg_instanceof_Window_a3b8566f0a9c5d1a: function() { return logError(function (arg0) {
            let result;
            try {
                result = arg0 instanceof Window;
            } catch (_) {
                result = false;
            }
            const ret = result;
            _assertBoolean(ret);
            return ret;
        }, arguments); },
        __wbg_isArray_5674713bb7b79043: function() { return logError(function (arg0) {
            const ret = Array.isArray(arg0);
            _assertBoolean(ret);
            return ret;
        }, arguments); },
        __wbg_isFallbackAdapter_4c8cc3b18677460a: function() { return logError(function (arg0) {
            const ret = arg0.isFallbackAdapter;
            _assertBoolean(ret);
            return ret;
        }, arguments); },
        __wbg_isSafeInteger_8f51c743827d1ec5: function() { return logError(function (arg0) {
            const ret = Number.isSafeInteger(arg0);
            _assertBoolean(ret);
            return ret;
        }, arguments); },
        __wbg_iterator_22ddeb808cf55a6f: function() { return logError(function () {
            const ret = Symbol.iterator;
            return ret;
        }, arguments); },
        __wbg_keys_54a4ebbf5c25691a: function() { return logError(function (arg0) {
            const ret = arg0.keys();
            return ret;
        }, arguments); },
        __wbg_label_7add8cb37a6ef98f: function() { return logError(function (arg0, arg1) {
            const ret = arg1.label;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        }, arguments); },
        __wbg_length_31bdaf014f5fbde2: function() { return logError(function (arg0) {
            const ret = arg0.length;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_length_4e1adc0d42e23620: function() { return logError(function (arg0) {
            const ret = arg0.length;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_limits_06bcb36c8409843b: function() { return logError(function (arg0) {
            const ret = arg0.limits;
            return ret;
        }, arguments); },
        __wbg_limits_601ad2e086ef8141: function() { return logError(function (arg0) {
            const ret = arg0.limits;
            return ret;
        }, arguments); },
        __wbg_lost_bb454eb62101af1a: function() { return logError(function (arg0) {
            const ret = arg0.lost;
            return ret;
        }, arguments); },
        __wbg_mapAsync_b0597127f5037286: function() { return logError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.mapAsync(arg1 >>> 0, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_matchMedia_0e1d9f8bfb0f1f46: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.matchMedia(getStringFromWasm0(arg1, arg2));
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_matches_0c791086704a6cb5: function() { return logError(function (arg0) {
            const ret = arg0.matches;
            _assertBoolean(ret);
            return ret;
        }, arguments); },
        __wbg_maxBindGroupsPlusVertexBuffers_52369f089736ef9d: function() { return logError(function (arg0) {
            const ret = arg0.maxBindGroupsPlusVertexBuffers;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxBindGroups_4e424afe6ce86ca2: function() { return logError(function (arg0) {
            const ret = arg0.maxBindGroups;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxBindingsPerBindGroup_7d035da36821c44f: function() { return logError(function (arg0) {
            const ret = arg0.maxBindingsPerBindGroup;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxBufferSize_423f4a084e32a195: function() { return logError(function (arg0) {
            const ret = arg0.maxBufferSize;
            return ret;
        }, arguments); },
        __wbg_maxColorAttachmentBytesPerSample_c4cd9126f6d287c6: function() { return logError(function (arg0) {
            const ret = arg0.maxColorAttachmentBytesPerSample;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxColorAttachments_d924670762b9e250: function() { return logError(function (arg0) {
            const ret = arg0.maxColorAttachments;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxComputeInvocationsPerWorkgroup_707a3868f7cebb59: function() { return logError(function (arg0) {
            const ret = arg0.maxComputeInvocationsPerWorkgroup;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxComputeWorkgroupSizeX_0a4d99463cbd6e5e: function() { return logError(function (arg0) {
            const ret = arg0.maxComputeWorkgroupSizeX;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxComputeWorkgroupSizeY_85123ea0587f7558: function() { return logError(function (arg0) {
            const ret = arg0.maxComputeWorkgroupSizeY;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxComputeWorkgroupSizeZ_a3186b4c5267d44f: function() { return logError(function (arg0) {
            const ret = arg0.maxComputeWorkgroupSizeZ;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxComputeWorkgroupStorageSize_57b297355cfb6204: function() { return logError(function (arg0) {
            const ret = arg0.maxComputeWorkgroupStorageSize;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxComputeWorkgroupsPerDimension_4158f95e673d54c4: function() { return logError(function (arg0) {
            const ret = arg0.maxComputeWorkgroupsPerDimension;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxDynamicStorageBuffersPerPipelineLayout_226b0b70910aa16c: function() { return logError(function (arg0) {
            const ret = arg0.maxDynamicStorageBuffersPerPipelineLayout;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxDynamicUniformBuffersPerPipelineLayout_0e835fda711fc7e6: function() { return logError(function (arg0) {
            const ret = arg0.maxDynamicUniformBuffersPerPipelineLayout;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxInterStageShaderVariables_8c4a1d727e2aa35a: function() { return logError(function (arg0) {
            const ret = arg0.maxInterStageShaderVariables;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxSampledTexturesPerShaderStage_6675f5e91d9a728a: function() { return logError(function (arg0) {
            const ret = arg0.maxSampledTexturesPerShaderStage;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxSamplersPerShaderStage_1910fa38a6ed1e1f: function() { return logError(function (arg0) {
            const ret = arg0.maxSamplersPerShaderStage;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxStorageBufferBindingSize_2e244bded070b18d: function() { return logError(function (arg0) {
            const ret = arg0.maxStorageBufferBindingSize;
            return ret;
        }, arguments); },
        __wbg_maxStorageBuffersPerShaderStage_a285f3ebca51ca0d: function() { return logError(function (arg0) {
            const ret = arg0.maxStorageBuffersPerShaderStage;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxStorageTexturesPerShaderStage_7aa946f0fc322a2b: function() { return logError(function (arg0) {
            const ret = arg0.maxStorageTexturesPerShaderStage;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxTextureArrayLayers_0e699147ad00502d: function() { return logError(function (arg0) {
            const ret = arg0.maxTextureArrayLayers;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxTextureDimension1D_aabf6add54decfe2: function() { return logError(function (arg0) {
            const ret = arg0.maxTextureDimension1D;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxTextureDimension2D_dd598b27e9c0c1c4: function() { return logError(function (arg0) {
            const ret = arg0.maxTextureDimension2D;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxTextureDimension3D_f944266c65dfd1a9: function() { return logError(function (arg0) {
            const ret = arg0.maxTextureDimension3D;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxUniformBufferBindingSize_59fa6be7cfbeeb53: function() { return logError(function (arg0) {
            const ret = arg0.maxUniformBufferBindingSize;
            return ret;
        }, arguments); },
        __wbg_maxUniformBuffersPerShaderStage_bee5f00a4d706c7f: function() { return logError(function (arg0) {
            const ret = arg0.maxUniformBuffersPerShaderStage;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxVertexAttributes_5cf6392c4e9033fe: function() { return logError(function (arg0) {
            const ret = arg0.maxVertexAttributes;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxVertexBufferArrayStride_548baa887375d865: function() { return logError(function (arg0) {
            const ret = arg0.maxVertexBufferArrayStride;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_maxVertexBuffers_75d881156591f5da: function() { return logError(function (arg0) {
            const ret = arg0.maxVertexBuffers;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_message_2aad50368e15e8f1: function() { return logError(function (arg0, arg1) {
            const ret = arg1.message;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        }, arguments); },
        __wbg_message_ab4cad9eeb386607: function() { return logError(function (arg0, arg1) {
            const ret = arg1.message;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        }, arguments); },
        __wbg_minStorageBufferOffsetAlignment_5ba9b77792bdadb3: function() { return logError(function (arg0) {
            const ret = arg0.minStorageBufferOffsetAlignment;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_minUniformBufferOffsetAlignment_ab7d52a5293b22bd: function() { return logError(function (arg0) {
            const ret = arg0.minUniformBufferOffsetAlignment;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_navigator_d217ca64c4bbff48: function() { return logError(function (arg0) {
            const ret = arg0.navigator;
            return ret;
        }, arguments); },
        __wbg_navigator_d25c0f071226f233: function() { return logError(function (arg0) {
            const ret = arg0.navigator;
            return ret;
        }, arguments); },
        __wbg_new_12e5d807044fbfe3: function() { return handleError(function (arg0, arg1) {
            const ret = new OffscreenCanvas(arg0 >>> 0, arg1 >>> 0);
            return ret;
        }, arguments); },
        __wbg_new_1da3429bc3c4541c: function() { return logError(function (arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        }, arguments); },
        __wbg_new_bebc3f4757acf305: function() { return logError(function () {
            const ret = new Object();
            return ret;
        }, arguments); },
        __wbg_new_typed_6f8b0d724fe26c07: function() { return logError(function (arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen__convert__closures_____invoke__h920b1d6c4a49b2c0(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        }, arguments); },
        __wbg_new_typed_7d4574ab4b8446c8: function() { return logError(function () {
            const ret = new Object();
            return ret;
        }, arguments); },
        __wbg_new_with_byte_offset_and_length_492c969e8b5da8a4: function() { return logError(function (arg0, arg1, arg2) {
            const ret = new Uint8Array(arg0, arg1 >>> 0, arg2 >>> 0);
            return ret;
        }, arguments); },
        __wbg_next_95053e306b1c3aed: function() { return logError(function (arg0) {
            const ret = arg0.next;
            return ret;
        }, arguments); },
        __wbg_next_f31ecb8646d2c605: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_now_fedc848f5cd360c5: function() { return logError(function () {
            const ret = performance.now();
            return ret;
        }, arguments); },
        __wbg_onSubmittedWorkDone_1190213cee1ecf7e: function() { return logError(function (arg0) {
            const ret = arg0.onSubmittedWorkDone();
            return ret;
        }, arguments); },
        __wbg_popDebugGroup_87cc10f02f9baa29: function() { return logError(function (arg0) {
            arg0.popDebugGroup();
        }, arguments); },
        __wbg_popDebugGroup_fc6cf5f2069b07ea: function() { return logError(function (arg0) {
            arg0.popDebugGroup();
        }, arguments); },
        __wbg_popErrorScope_182b8e03671d81ef: function() { return logError(function (arg0) {
            const ret = arg0.popErrorScope();
            return ret;
        }, arguments); },
        __wbg_prototypesetcall_ae9f5e7459250748: function() { return logError(function (arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        }, arguments); },
        __wbg_pushDebugGroup_20949a2b29d3bd19: function() { return logError(function (arg0, arg1, arg2) {
            arg0.pushDebugGroup(getStringFromWasm0(arg1, arg2));
        }, arguments); },
        __wbg_pushDebugGroup_356e96c0f79bab32: function() { return logError(function (arg0, arg1, arg2) {
            arg0.pushDebugGroup(getStringFromWasm0(arg1, arg2));
        }, arguments); },
        __wbg_pushErrorScope_fa7df784c43bdb51: function() { return logError(function (arg0, arg1) {
            arg0.pushErrorScope(__wbindgen_enum_GpuErrorFilter[arg1]);
        }, arguments); },
        __wbg_querySelectorAll_fdbf93e11103921d: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.querySelectorAll(getStringFromWasm0(arg1, arg2));
            return ret;
        }, arguments); },
        __wbg_queueMicrotask_85c90f6987555d65: function() { return logError(function (arg0) {
            const ret = arg0.queueMicrotask;
            return ret;
        }, arguments); },
        __wbg_queueMicrotask_f6a1fa10b81d1fc0: function() { return logError(function (arg0) {
            queueMicrotask(arg0);
        }, arguments); },
        __wbg_queue_7b62c28143d44293: function() { return logError(function (arg0) {
            const ret = arg0.queue;
            return ret;
        }, arguments); },
        __wbg_reason_b4fa3af867fc4430: function() { return logError(function (arg0) {
            const ret = arg0.reason;
            return (__wbindgen_enum_GpuDeviceLostReason.indexOf(ret) + 1 || 3) - 1;
        }, arguments); },
        __wbg_renderer_new: function() { return logError(function (arg0) {
            const ret = Renderer.__wrap(arg0);
            return ret;
        }, arguments); },
        __wbg_requestAdapter_a539af006419f2e9: function() { return logError(function (arg0, arg1) {
            const ret = arg0.requestAdapter(arg1);
            return ret;
        }, arguments); },
        __wbg_requestDevice_5cb8a582e55d08cb: function() { return logError(function (arg0, arg1) {
            const ret = arg0.requestDevice(arg1);
            return ret;
        }, arguments); },
        __wbg_resolveQuerySet_770f23fabac49845: function() { return logError(function (arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.resolveQuerySet(arg1, arg2 >>> 0, arg3 >>> 0, arg4, arg5 >>> 0);
        }, arguments); },
        __wbg_resolve_35ec7e0c6af4c82c: function() { return logError(function (arg0) {
            const ret = Promise.resolve(arg0);
            return ret;
        }, arguments); },
        __wbg_run_f19543b086e90d43: function() { return logError(function (arg0, arg1, arg2) {
            try {
                var state0 = {a: arg1, b: arg2};
                var cb0 = () => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen__convert__closures_____invoke__hd4a907be06eb37af(a, state0.b, );
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = arg0.run(cb0);
                _assertBoolean(ret);
                return ret;
            } finally {
                state0.a = 0;
            }
        }, arguments); },
        __wbg_setBindGroup_11bdbb60cc8b54b9: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
            arg0.setBindGroup(arg1 >>> 0, arg2, getArrayU32FromWasm0(arg3, arg4), arg5, arg6 >>> 0);
        }, arguments); },
        __wbg_setBindGroup_418c3e0eb6943ce0: function() { return logError(function (arg0, arg1, arg2) {
            arg0.setBindGroup(arg1 >>> 0, arg2);
        }, arguments); },
        __wbg_setBlendConstant_c6cbc557f3f85fa7: function() { return handleError(function (arg0, arg1) {
            arg0.setBlendConstant(arg1);
        }, arguments); },
        __wbg_setIndexBuffer_01327df91742b73e: function() { return logError(function (arg0, arg1, arg2, arg3) {
            arg0.setIndexBuffer(arg1, __wbindgen_enum_GpuIndexFormat[arg2], arg3);
        }, arguments); },
        __wbg_setIndexBuffer_241097e303986c14: function() { return logError(function (arg0, arg1, arg2, arg3, arg4) {
            arg0.setIndexBuffer(arg1, __wbindgen_enum_GpuIndexFormat[arg2], arg3, arg4);
        }, arguments); },
        __wbg_setPipeline_b6f981027e02cd16: function() { return logError(function (arg0, arg1) {
            arg0.setPipeline(arg1);
        }, arguments); },
        __wbg_setScissorRect_889235eeb784732b: function() { return logError(function (arg0, arg1, arg2, arg3, arg4) {
            arg0.setScissorRect(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
        }, arguments); },
        __wbg_setStencilReference_48705a9a2cceae02: function() { return logError(function (arg0, arg1) {
            arg0.setStencilReference(arg1 >>> 0);
        }, arguments); },
        __wbg_setVertexBuffer_6db3b60e99280744: function() { return logError(function (arg0, arg1, arg2, arg3) {
            arg0.setVertexBuffer(arg1 >>> 0, arg2, arg3);
        }, arguments); },
        __wbg_setVertexBuffer_cbf4ca1627c02f4c: function() { return logError(function (arg0, arg1, arg2, arg3, arg4) {
            arg0.setVertexBuffer(arg1 >>> 0, arg2, arg3, arg4);
        }, arguments); },
        __wbg_setViewport_c0be08dcc8965ccf: function() { return logError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
            arg0.setViewport(arg1, arg2, arg3, arg4, arg5, arg6);
        }, arguments); },
        __wbg_set_a377297433dfea63: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            _assertBoolean(ret);
            return ret;
        }, arguments); },
        __wbg_set_a_82818effc94f6256: function() { return logError(function (arg0, arg1) {
            arg0.a = arg1;
        }, arguments); },
        __wbg_set_access_a099cfbbeec9b96f: function() { return logError(function (arg0, arg1) {
            arg0.access = __wbindgen_enum_GpuStorageTextureAccess[arg1];
        }, arguments); },
        __wbg_set_address_mode_u_a68737cf5d288f95: function() { return logError(function (arg0, arg1) {
            arg0.addressModeU = __wbindgen_enum_GpuAddressMode[arg1];
        }, arguments); },
        __wbg_set_address_mode_v_b1c3c45933f540d1: function() { return logError(function (arg0, arg1) {
            arg0.addressModeV = __wbindgen_enum_GpuAddressMode[arg1];
        }, arguments); },
        __wbg_set_address_mode_w_889c31cf7022c764: function() { return logError(function (arg0, arg1) {
            arg0.addressModeW = __wbindgen_enum_GpuAddressMode[arg1];
        }, arguments); },
        __wbg_set_alpha_106f21a936a85eba: function() { return logError(function (arg0, arg1) {
            arg0.alpha = arg1;
        }, arguments); },
        __wbg_set_alpha_mode_5544568dbac50280: function() { return logError(function (arg0, arg1) {
            arg0.alphaMode = __wbindgen_enum_GpuCanvasAlphaMode[arg1];
        }, arguments); },
        __wbg_set_alpha_to_coverage_enabled_3372ce329447b8f1: function() { return logError(function (arg0, arg1) {
            arg0.alphaToCoverageEnabled = arg1 !== 0;
        }, arguments); },
        __wbg_set_array_layer_count_22afa0a979e4ad55: function() { return logError(function (arg0, arg1) {
            arg0.arrayLayerCount = arg1 >>> 0;
        }, arguments); },
        __wbg_set_array_stride_f64_6816040e5e7598c3: function() { return logError(function (arg0, arg1) {
            arg0.arrayStride = arg1;
        }, arguments); },
        __wbg_set_aspect_9de5253d4c460895: function() { return logError(function (arg0, arg1) {
            arg0.aspect = __wbindgen_enum_GpuTextureAspect[arg1];
        }, arguments); },
        __wbg_set_aspect_a48d046965270281: function() { return logError(function (arg0, arg1) {
            arg0.aspect = __wbindgen_enum_GpuTextureAspect[arg1];
        }, arguments); },
        __wbg_set_aspect_b1a9909bf315433f: function() { return logError(function (arg0, arg1) {
            arg0.aspect = __wbindgen_enum_GpuTextureAspect[arg1];
        }, arguments); },
        __wbg_set_attributes_9e38cb1dde387a5b: function() { return logError(function (arg0, arg1, arg2) {
            arg0.attributes = getArrayJsValueViewFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_b_a3297ee7e7cac3a8: function() { return logError(function (arg0, arg1) {
            arg0.b = arg1;
        }, arguments); },
        __wbg_set_base_array_layer_2435ba92c80346ae: function() { return logError(function (arg0, arg1) {
            arg0.baseArrayLayer = arg1 >>> 0;
        }, arguments); },
        __wbg_set_base_mip_level_8b6093e875e7c65d: function() { return logError(function (arg0, arg1) {
            arg0.baseMipLevel = arg1 >>> 0;
        }, arguments); },
        __wbg_set_beginning_of_pass_write_index_e552c5e8b8bbf52f: function() { return logError(function (arg0, arg1) {
            arg0.beginningOfPassWriteIndex = arg1 >>> 0;
        }, arguments); },
        __wbg_set_beginning_of_pass_write_index_fa9ae10d5d2804ce: function() { return logError(function (arg0, arg1) {
            arg0.beginningOfPassWriteIndex = arg1 >>> 0;
        }, arguments); },
        __wbg_set_bind_group_layouts_458c44ba55100b82: function() { return logError(function (arg0, arg1, arg2) {
            arg0.bindGroupLayouts = getArrayJsValueViewFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_binding_81b3fac7f7acaf8d: function() { return logError(function (arg0, arg1) {
            arg0.binding = arg1 >>> 0;
        }, arguments); },
        __wbg_set_binding_b6cee57f35ac5190: function() { return logError(function (arg0, arg1) {
            arg0.binding = arg1 >>> 0;
        }, arguments); },
        __wbg_set_blend_1a801617945f7945: function() { return logError(function (arg0, arg1) {
            arg0.blend = arg1;
        }, arguments); },
        __wbg_set_buffer_1548ae88a9188037: function() { return logError(function (arg0, arg1) {
            arg0.buffer = arg1;
        }, arguments); },
        __wbg_set_buffer_8d0ac64ad20dfc84: function() { return logError(function (arg0, arg1) {
            arg0.buffer = arg1;
        }, arguments); },
        __wbg_set_buffer_910a40a90f97cfca: function() { return logError(function (arg0, arg1) {
            arg0.buffer = arg1;
        }, arguments); },
        __wbg_set_buffers_5d0e0c50791f710e: function() { return logError(function (arg0, arg1, arg2) {
            arg0.buffers = getArrayJsValueViewFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_bytes_per_row_1e824a5502b54b3d: function() { return logError(function (arg0, arg1) {
            arg0.bytesPerRow = arg1 >>> 0;
        }, arguments); },
        __wbg_set_bytes_per_row_c28583f0063160f1: function() { return logError(function (arg0, arg1) {
            arg0.bytesPerRow = arg1 >>> 0;
        }, arguments); },
        __wbg_set_clear_value_gpu_color_dict_a9f763e8372ac1de: function() { return logError(function (arg0, arg1) {
            arg0.clearValue = arg1;
        }, arguments); },
        __wbg_set_code_5d5b0b9e2fd0dca7: function() { return logError(function (arg0, arg1, arg2) {
            arg0.code = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_color_8ecace4011f47d2e: function() { return logError(function (arg0, arg1) {
            arg0.color = arg1;
        }, arguments); },
        __wbg_set_color_attachments_622fe2d5997fda7a: function() { return logError(function (arg0, arg1, arg2) {
            arg0.colorAttachments = getArrayJsValueViewFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_color_formats_09c913b40390ec8b: function() { return logError(function (arg0, arg1, arg2) {
            arg0.colorFormats = getArrayJsValueViewFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_compare_080c9e492ff36990: function() { return logError(function (arg0, arg1) {
            arg0.compare = __wbindgen_enum_GpuCompareFunction[arg1];
        }, arguments); },
        __wbg_set_compare_817cf3695599eaa6: function() { return logError(function (arg0, arg1) {
            arg0.compare = __wbindgen_enum_GpuCompareFunction[arg1];
        }, arguments); },
        __wbg_set_compute_bc754d9e37f6e4c9: function() { return logError(function (arg0, arg1) {
            arg0.compute = arg1;
        }, arguments); },
        __wbg_set_count_8ff0c9474e39a849: function() { return logError(function (arg0, arg1) {
            arg0.count = arg1 >>> 0;
        }, arguments); },
        __wbg_set_count_d9dc88156fd05bc7: function() { return logError(function (arg0, arg1) {
            arg0.count = arg1 >>> 0;
        }, arguments); },
        __wbg_set_cull_mode_85d2b4ab0ce3a564: function() { return logError(function (arg0, arg1) {
            arg0.cullMode = __wbindgen_enum_GpuCullMode[arg1];
        }, arguments); },
        __wbg_set_depth_bias_95abf479cae3f3cd: function() { return logError(function (arg0, arg1) {
            arg0.depthBias = arg1;
        }, arguments); },
        __wbg_set_depth_bias_clamp_ba3d0b8348151350: function() { return logError(function (arg0, arg1) {
            arg0.depthBiasClamp = arg1;
        }, arguments); },
        __wbg_set_depth_bias_slope_scale_6b2584d93f5b9cd2: function() { return logError(function (arg0, arg1) {
            arg0.depthBiasSlopeScale = arg1;
        }, arguments); },
        __wbg_set_depth_clear_value_e30a4c754c6b3b26: function() { return logError(function (arg0, arg1) {
            arg0.depthClearValue = arg1;
        }, arguments); },
        __wbg_set_depth_compare_a90de4e3714397ab: function() { return logError(function (arg0, arg1) {
            arg0.depthCompare = __wbindgen_enum_GpuCompareFunction[arg1];
        }, arguments); },
        __wbg_set_depth_fail_op_b5c64541d1b6b482: function() { return logError(function (arg0, arg1) {
            arg0.depthFailOp = __wbindgen_enum_GpuStencilOperation[arg1];
        }, arguments); },
        __wbg_set_depth_load_op_932888016d762d3e: function() { return logError(function (arg0, arg1) {
            arg0.depthLoadOp = __wbindgen_enum_GpuLoadOp[arg1];
        }, arguments); },
        __wbg_set_depth_or_array_layers_e2f074a0284e4806: function() { return logError(function (arg0, arg1) {
            arg0.depthOrArrayLayers = arg1 >>> 0;
        }, arguments); },
        __wbg_set_depth_read_only_4930681225f8fc3b: function() { return logError(function (arg0, arg1) {
            arg0.depthReadOnly = arg1 !== 0;
        }, arguments); },
        __wbg_set_depth_read_only_be790175a1c2db9a: function() { return logError(function (arg0, arg1) {
            arg0.depthReadOnly = arg1 !== 0;
        }, arguments); },
        __wbg_set_depth_stencil_attachment_54a8922f5fbe08bf: function() { return logError(function (arg0, arg1) {
            arg0.depthStencilAttachment = arg1;
        }, arguments); },
        __wbg_set_depth_stencil_b7cffc59ad4da529: function() { return logError(function (arg0, arg1) {
            arg0.depthStencil = arg1;
        }, arguments); },
        __wbg_set_depth_stencil_format_7fdbf2eb56b8265d: function() { return logError(function (arg0, arg1) {
            arg0.depthStencilFormat = __wbindgen_enum_GpuTextureFormat[arg1];
        }, arguments); },
        __wbg_set_depth_store_op_9054814f164ab55d: function() { return logError(function (arg0, arg1) {
            arg0.depthStoreOp = __wbindgen_enum_GpuStoreOp[arg1];
        }, arguments); },
        __wbg_set_depth_write_enabled_31a821ee1fb3b0b3: function() { return logError(function (arg0, arg1) {
            arg0.depthWriteEnabled = arg1 !== 0;
        }, arguments); },
        __wbg_set_device_210484a77b675c9c: function() { return logError(function (arg0, arg1) {
            arg0.device = arg1;
        }, arguments); },
        __wbg_set_dimension_3da9d03131a9f446: function() { return logError(function (arg0, arg1) {
            arg0.dimension = __wbindgen_enum_GpuTextureDimension[arg1];
        }, arguments); },
        __wbg_set_dimension_56332450afa3e0c0: function() { return logError(function (arg0, arg1) {
            arg0.dimension = __wbindgen_enum_GpuTextureViewDimension[arg1];
        }, arguments); },
        __wbg_set_dst_factor_865ba9aaf187890c: function() { return logError(function (arg0, arg1) {
            arg0.dstFactor = __wbindgen_enum_GpuBlendFactor[arg1];
        }, arguments); },
        __wbg_set_end_of_pass_write_index_8f164f9e60d4ad16: function() { return logError(function (arg0, arg1) {
            arg0.endOfPassWriteIndex = arg1 >>> 0;
        }, arguments); },
        __wbg_set_end_of_pass_write_index_b54a8e3802b9ae0d: function() { return logError(function (arg0, arg1) {
            arg0.endOfPassWriteIndex = arg1 >>> 0;
        }, arguments); },
        __wbg_set_entries_6f866302103b81e9: function() { return logError(function (arg0, arg1, arg2) {
            arg0.entries = getArrayJsValueViewFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_entries_f26b77ab9548e906: function() { return logError(function (arg0, arg1, arg2) {
            arg0.entries = getArrayJsValueViewFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_entry_point_71cef95c137b5774: function() { return logError(function (arg0, arg1, arg2) {
            arg0.entryPoint = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_entry_point_ac8db535971761fe: function() { return logError(function (arg0, arg1, arg2) {
            arg0.entryPoint = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_entry_point_b70f98f5025a114d: function() { return logError(function (arg0, arg1, arg2) {
            arg0.entryPoint = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_external_texture_7f966c604c4f8098: function() { return logError(function (arg0, arg1) {
            arg0.externalTexture = arg1;
        }, arguments); },
        __wbg_set_fail_op_d59d0187e4111dfe: function() { return logError(function (arg0, arg1) {
            arg0.failOp = __wbindgen_enum_GpuStencilOperation[arg1];
        }, arguments); },
        __wbg_set_flip_y_5a9a7c3fd5a2314e: function() { return logError(function (arg0, arg1) {
            arg0.flipY = arg1 !== 0;
        }, arguments); },
        __wbg_set_format_23f7f32549751d43: function() { return logError(function (arg0, arg1) {
            arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
        }, arguments); },
        __wbg_set_format_283dca56552f07a3: function() { return logError(function (arg0, arg1) {
            arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
        }, arguments); },
        __wbg_set_format_5080a858117ad2c1: function() { return logError(function (arg0, arg1) {
            arg0.format = __wbindgen_enum_GpuVertexFormat[arg1];
        }, arguments); },
        __wbg_set_format_66735b94bd868ba2: function() { return logError(function (arg0, arg1) {
            arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
        }, arguments); },
        __wbg_set_format_7f2bdbfb101b1ae1: function() { return logError(function (arg0, arg1) {
            arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
        }, arguments); },
        __wbg_set_format_92732ea75d3b79f5: function() { return logError(function (arg0, arg1) {
            arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
        }, arguments); },
        __wbg_set_format_f009e603f7d4c28e: function() { return logError(function (arg0, arg1) {
            arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
        }, arguments); },
        __wbg_set_fragment_d2b0ec97d7cf8d47: function() { return logError(function (arg0, arg1) {
            arg0.fragment = arg1;
        }, arguments); },
        __wbg_set_front_face_d3f8a2e07e7b25dd: function() { return logError(function (arg0, arg1) {
            arg0.frontFace = __wbindgen_enum_GpuFrontFace[arg1];
        }, arguments); },
        __wbg_set_g_b527ee8a9bed553d: function() { return logError(function (arg0, arg1) {
            arg0.g = arg1;
        }, arguments); },
        __wbg_set_has_dynamic_offset_0c72ffa900c5a269: function() { return logError(function (arg0, arg1) {
            arg0.hasDynamicOffset = arg1 !== 0;
        }, arguments); },
        __wbg_set_height_1202ad0eab43cbe0: function() { return logError(function (arg0, arg1) {
            arg0.height = arg1 >>> 0;
        }, arguments); },
        __wbg_set_height_698fb3b255bc1348: function() { return logError(function (arg0, arg1) {
            arg0.height = arg1 >>> 0;
        }, arguments); },
        __wbg_set_height_f6619158e5735877: function() { return logError(function (arg0, arg1) {
            arg0.height = arg1 >>> 0;
        }, arguments); },
        __wbg_set_label_09e2da5f8522dbe8: function() { return logError(function (arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_label_17202740051e9722: function() { return logError(function (arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_label_17b4858e1eef23dd: function() { return logError(function (arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_label_2fefb39c0e0dbbe8: function() { return logError(function (arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_label_3cb2322e6f6db14c: function() { return logError(function (arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_label_3f2ccaafef5ff7c9: function() { return logError(function (arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_label_612add98a4398f92: function() { return logError(function (arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_label_6f69e25822616a1b: function() { return logError(function (arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_label_70a09ee68d6b1b26: function() { return logError(function (arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_label_92cd3811e96b487c: function() { return logError(function (arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_label_9c2a186152427ee0: function() { return logError(function (arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_label_a0b034da32cc8a96: function() { return logError(function (arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_label_c3eaf136aa464cba: function() { return logError(function (arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_label_c7987704d29f284b: function() { return logError(function (arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_label_cfe64bca8945ee30: function() { return logError(function (arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_label_e02179cf97e95763: function() { return logError(function (arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_label_ee172cd5f6a96961: function() { return logError(function (arg0, arg1, arg2) {
            arg0.label = getStringFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_layout_454e3a091b390cd4: function() { return logError(function (arg0, arg1) {
            arg0.layout = arg1;
        }, arguments); },
        __wbg_set_layout_4b5d5b12fbb72a76: function() { return logError(function (arg0, arg1) {
            arg0.layout = arg1;
        }, arguments); },
        __wbg_set_layout_75dc1ca3f2421cff: function() { return logError(function (arg0, arg1) {
            arg0.layout = arg1;
        }, arguments); },
        __wbg_set_layout_gpu_auto_layout_mode_06a2b95af1043098: function() { return logError(function (arg0, arg1) {
            arg0.layout = __wbindgen_enum_GpuAutoLayoutMode[arg1];
        }, arguments); },
        __wbg_set_layout_gpu_auto_layout_mode_ee432e515c357fa8: function() { return logError(function (arg0, arg1) {
            arg0.layout = __wbindgen_enum_GpuAutoLayoutMode[arg1];
        }, arguments); },
        __wbg_set_load_op_c56b1269acc2d51f: function() { return logError(function (arg0, arg1) {
            arg0.loadOp = __wbindgen_enum_GpuLoadOp[arg1];
        }, arguments); },
        __wbg_set_lod_max_clamp_db24179f67f3aa31: function() { return logError(function (arg0, arg1) {
            arg0.lodMaxClamp = arg1;
        }, arguments); },
        __wbg_set_lod_min_clamp_2bbce566e9fefa04: function() { return logError(function (arg0, arg1) {
            arg0.lodMinClamp = arg1;
        }, arguments); },
        __wbg_set_mag_filter_db8e6b42d4f8846d: function() { return logError(function (arg0, arg1) {
            arg0.magFilter = __wbindgen_enum_GpuFilterMode[arg1];
        }, arguments); },
        __wbg_set_mapped_at_creation_3f320fef6761b02c: function() { return logError(function (arg0, arg1) {
            arg0.mappedAtCreation = arg1 !== 0;
        }, arguments); },
        __wbg_set_mask_c1079e551ec360dc: function() { return logError(function (arg0, arg1) {
            arg0.mask = arg1 >>> 0;
        }, arguments); },
        __wbg_set_max_anisotropy_84749fdcec362dc4: function() { return logError(function (arg0, arg1) {
            arg0.maxAnisotropy = arg1;
        }, arguments); },
        __wbg_set_min_binding_size_f64_897e3cd4496ddec9: function() { return logError(function (arg0, arg1) {
            arg0.minBindingSize = arg1;
        }, arguments); },
        __wbg_set_min_filter_d435bbfc5a637757: function() { return logError(function (arg0, arg1) {
            arg0.minFilter = __wbindgen_enum_GpuFilterMode[arg1];
        }, arguments); },
        __wbg_set_mip_level_03ed7bbd0ded367f: function() { return logError(function (arg0, arg1) {
            arg0.mipLevel = arg1 >>> 0;
        }, arguments); },
        __wbg_set_mip_level_count_047936c630acee7b: function() { return logError(function (arg0, arg1) {
            arg0.mipLevelCount = arg1 >>> 0;
        }, arguments); },
        __wbg_set_mip_level_count_44bc46a1ae6f6daa: function() { return logError(function (arg0, arg1) {
            arg0.mipLevelCount = arg1 >>> 0;
        }, arguments); },
        __wbg_set_mip_level_f3745730372683d5: function() { return logError(function (arg0, arg1) {
            arg0.mipLevel = arg1 >>> 0;
        }, arguments); },
        __wbg_set_mipmap_filter_62fb49a84b0747ff: function() { return logError(function (arg0, arg1) {
            arg0.mipmapFilter = __wbindgen_enum_GpuMipmapFilterMode[arg1];
        }, arguments); },
        __wbg_set_mode_7edfbc344ef9c650: function() { return logError(function (arg0, arg1) {
            arg0.mode = __wbindgen_enum_GpuCanvasToneMappingMode[arg1];
        }, arguments); },
        __wbg_set_module_392eeaa269f203b0: function() { return logError(function (arg0, arg1) {
            arg0.module = arg1;
        }, arguments); },
        __wbg_set_module_715d37652c4998ec: function() { return logError(function (arg0, arg1) {
            arg0.module = arg1;
        }, arguments); },
        __wbg_set_module_c9946af218d23b53: function() { return logError(function (arg0, arg1) {
            arg0.module = arg1;
        }, arguments); },
        __wbg_set_multisample_ff72a7a5456cbeb7: function() { return logError(function (arg0, arg1) {
            arg0.multisample = arg1;
        }, arguments); },
        __wbg_set_multisampled_039f032dc4b67367: function() { return logError(function (arg0, arg1) {
            arg0.multisampled = arg1 !== 0;
        }, arguments); },
        __wbg_set_offset_f64_127e8a0aa5c5485a: function() { return logError(function (arg0, arg1) {
            arg0.offset = arg1;
        }, arguments); },
        __wbg_set_offset_f64_457756429ede426d: function() { return logError(function (arg0, arg1) {
            arg0.offset = arg1;
        }, arguments); },
        __wbg_set_offset_f64_a903425d5a8e5815: function() { return logError(function (arg0, arg1) {
            arg0.offset = arg1;
        }, arguments); },
        __wbg_set_offset_f64_d1d115dd438165b5: function() { return logError(function (arg0, arg1) {
            arg0.offset = arg1;
        }, arguments); },
        __wbg_set_onuncapturederror_bb813f1102da2296: function() { return logError(function (arg0, arg1) {
            arg0.onuncapturederror = arg1;
        }, arguments); },
        __wbg_set_operation_00a77386523b88f9: function() { return logError(function (arg0, arg1) {
            arg0.operation = __wbindgen_enum_GpuBlendOperation[arg1];
        }, arguments); },
        __wbg_set_origin_gpu_origin_2d_dict_8156da81552cd590: function() { return logError(function (arg0, arg1) {
            arg0.origin = arg1;
        }, arguments); },
        __wbg_set_origin_gpu_origin_3d_dict_0619d4860adb4eb6: function() { return logError(function (arg0, arg1) {
            arg0.origin = arg1;
        }, arguments); },
        __wbg_set_origin_gpu_origin_3d_dict_abd0dec737979786: function() { return logError(function (arg0, arg1) {
            arg0.origin = arg1;
        }, arguments); },
        __wbg_set_pass_op_3cf10feb3d76ab97: function() { return logError(function (arg0, arg1) {
            arg0.passOp = __wbindgen_enum_GpuStencilOperation[arg1];
        }, arguments); },
        __wbg_set_power_preference_b42d00a8facfbade: function() { return logError(function (arg0, arg1) {
            arg0.powerPreference = __wbindgen_enum_GpuPowerPreference[arg1];
        }, arguments); },
        __wbg_set_premultiplied_alpha_6d23532454ce9a12: function() { return logError(function (arg0, arg1) {
            arg0.premultipliedAlpha = arg1 !== 0;
        }, arguments); },
        __wbg_set_primitive_e796cf76f0ff89f3: function() { return logError(function (arg0, arg1) {
            arg0.primitive = arg1;
        }, arguments); },
        __wbg_set_query_set_f030702f1b69199f: function() { return logError(function (arg0, arg1) {
            arg0.querySet = arg1;
        }, arguments); },
        __wbg_set_query_set_f9a94586851fdba2: function() { return logError(function (arg0, arg1) {
            arg0.querySet = arg1;
        }, arguments); },
        __wbg_set_r_6ece4d74af63364f: function() { return logError(function (arg0, arg1) {
            arg0.r = arg1;
        }, arguments); },
        __wbg_set_required_features_bbab71414c45e621: function() { return logError(function (arg0, arg1, arg2) {
            arg0.requiredFeatures = getArrayJsValueViewFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_required_limits_837f62d865e7cfac: function() { return logError(function (arg0, arg1) {
            arg0.requiredLimits = arg1;
        }, arguments); },
        __wbg_set_resolve_target_gpu_texture_view_e4c1e3bbb8c27d87: function() { return logError(function (arg0, arg1) {
            arg0.resolveTarget = arg1;
        }, arguments); },
        __wbg_set_resource_8fd8658b30d86ecf: function() { return logError(function (arg0, arg1) {
            arg0.resource = arg1;
        }, arguments); },
        __wbg_set_resource_gpu_buffer_binding_33099b25da65b610: function() { return logError(function (arg0, arg1) {
            arg0.resource = arg1;
        }, arguments); },
        __wbg_set_resource_gpu_texture_view_4cffe7bc7c8e5cbe: function() { return logError(function (arg0, arg1) {
            arg0.resource = arg1;
        }, arguments); },
        __wbg_set_rows_per_image_c6d50d227e634379: function() { return logError(function (arg0, arg1) {
            arg0.rowsPerImage = arg1 >>> 0;
        }, arguments); },
        __wbg_set_rows_per_image_deb456502f23c260: function() { return logError(function (arg0, arg1) {
            arg0.rowsPerImage = arg1 >>> 0;
        }, arguments); },
        __wbg_set_sample_count_481c255a12054e1d: function() { return logError(function (arg0, arg1) {
            arg0.sampleCount = arg1 >>> 0;
        }, arguments); },
        __wbg_set_sample_count_4f58e866b57077cc: function() { return logError(function (arg0, arg1) {
            arg0.sampleCount = arg1 >>> 0;
        }, arguments); },
        __wbg_set_sample_type_ebc5fcd029513bda: function() { return logError(function (arg0, arg1) {
            arg0.sampleType = __wbindgen_enum_GpuTextureSampleType[arg1];
        }, arguments); },
        __wbg_set_sampler_89cb4a7efcfc6005: function() { return logError(function (arg0, arg1) {
            arg0.sampler = arg1;
        }, arguments); },
        __wbg_set_shader_location_3fb9f6a012eba494: function() { return logError(function (arg0, arg1) {
            arg0.shaderLocation = arg1 >>> 0;
        }, arguments); },
        __wbg_set_size_f64_2f591b0654540477: function() { return logError(function (arg0, arg1) {
            arg0.size = arg1;
        }, arguments); },
        __wbg_set_size_f64_e844c985b8f95261: function() { return logError(function (arg0, arg1) {
            arg0.size = arg1;
        }, arguments); },
        __wbg_set_size_gpu_extent_3d_dict_adf57388ab1d4f18: function() { return logError(function (arg0, arg1) {
            arg0.size = arg1;
        }, arguments); },
        __wbg_set_source_211aa06496d82b73: function() { return logError(function (arg0, arg1) {
            arg0.source = arg1;
        }, arguments); },
        __wbg_set_source_html_canvas_element_5577621adc0f8ff6: function() { return logError(function (arg0, arg1) {
            arg0.source = arg1;
        }, arguments); },
        __wbg_set_source_html_image_element_23fa06e99ca07cc0: function() { return logError(function (arg0, arg1) {
            arg0.source = arg1;
        }, arguments); },
        __wbg_set_source_html_video_element_e57b5cacb7b02736: function() { return logError(function (arg0, arg1) {
            arg0.source = arg1;
        }, arguments); },
        __wbg_set_source_image_data_c80600573a809775: function() { return logError(function (arg0, arg1) {
            arg0.source = arg1;
        }, arguments); },
        __wbg_set_source_offscreen_canvas_7d49271754887b4e: function() { return logError(function (arg0, arg1) {
            arg0.source = arg1;
        }, arguments); },
        __wbg_set_source_video_frame_e4faebda27c393e4: function() { return logError(function (arg0, arg1) {
            arg0.source = arg1;
        }, arguments); },
        __wbg_set_src_factor_6f2c9ec8e4d3d979: function() { return logError(function (arg0, arg1) {
            arg0.srcFactor = __wbindgen_enum_GpuBlendFactor[arg1];
        }, arguments); },
        __wbg_set_stencil_back_c54d0443b8b6a957: function() { return logError(function (arg0, arg1) {
            arg0.stencilBack = arg1;
        }, arguments); },
        __wbg_set_stencil_clear_value_a321b0e045bfd8c2: function() { return logError(function (arg0, arg1) {
            arg0.stencilClearValue = arg1 >>> 0;
        }, arguments); },
        __wbg_set_stencil_front_3ff3f8385852efff: function() { return logError(function (arg0, arg1) {
            arg0.stencilFront = arg1;
        }, arguments); },
        __wbg_set_stencil_load_op_37d20deccb26a0f1: function() { return logError(function (arg0, arg1) {
            arg0.stencilLoadOp = __wbindgen_enum_GpuLoadOp[arg1];
        }, arguments); },
        __wbg_set_stencil_read_mask_021ef4271b24352c: function() { return logError(function (arg0, arg1) {
            arg0.stencilReadMask = arg1 >>> 0;
        }, arguments); },
        __wbg_set_stencil_read_only_4a9ed1a220f46a89: function() { return logError(function (arg0, arg1) {
            arg0.stencilReadOnly = arg1 !== 0;
        }, arguments); },
        __wbg_set_stencil_read_only_75fe66a2356d6e92: function() { return logError(function (arg0, arg1) {
            arg0.stencilReadOnly = arg1 !== 0;
        }, arguments); },
        __wbg_set_stencil_store_op_501f91638dd386e6: function() { return logError(function (arg0, arg1) {
            arg0.stencilStoreOp = __wbindgen_enum_GpuStoreOp[arg1];
        }, arguments); },
        __wbg_set_stencil_write_mask_ec1c12237e094bdd: function() { return logError(function (arg0, arg1) {
            arg0.stencilWriteMask = arg1 >>> 0;
        }, arguments); },
        __wbg_set_step_mode_3cbbdeba1e5dfd62: function() { return logError(function (arg0, arg1) {
            arg0.stepMode = __wbindgen_enum_GpuVertexStepMode[arg1];
        }, arguments); },
        __wbg_set_storage_texture_786aea7c5773b6c1: function() { return logError(function (arg0, arg1) {
            arg0.storageTexture = arg1;
        }, arguments); },
        __wbg_set_store_op_678f33376d741711: function() { return logError(function (arg0, arg1) {
            arg0.storeOp = __wbindgen_enum_GpuStoreOp[arg1];
        }, arguments); },
        __wbg_set_strip_index_format_70313df755145d5e: function() { return logError(function (arg0, arg1) {
            arg0.stripIndexFormat = __wbindgen_enum_GpuIndexFormat[arg1];
        }, arguments); },
        __wbg_set_targets_674b33931e512fb1: function() { return logError(function (arg0, arg1, arg2) {
            arg0.targets = getArrayJsValueViewFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_texture_4e0ee4c98ac25b81: function() { return logError(function (arg0, arg1) {
            arg0.texture = arg1;
        }, arguments); },
        __wbg_set_texture_95f2bfdf7767e76f: function() { return logError(function (arg0, arg1) {
            arg0.texture = arg1;
        }, arguments); },
        __wbg_set_texture_a33be3fe02ac6264: function() { return logError(function (arg0, arg1) {
            arg0.texture = arg1;
        }, arguments); },
        __wbg_set_timestamp_writes_5f240bbaad97fcaf: function() { return logError(function (arg0, arg1) {
            arg0.timestampWrites = arg1;
        }, arguments); },
        __wbg_set_timestamp_writes_de6a09f299b71b76: function() { return logError(function (arg0, arg1) {
            arg0.timestampWrites = arg1;
        }, arguments); },
        __wbg_set_tone_mapping_320c1aad31db2e7f: function() { return logError(function (arg0, arg1) {
            arg0.toneMapping = arg1;
        }, arguments); },
        __wbg_set_topology_b92cfe523bd9653b: function() { return logError(function (arg0, arg1) {
            arg0.topology = __wbindgen_enum_GpuPrimitiveTopology[arg1];
        }, arguments); },
        __wbg_set_type_43e0092f16775979: function() { return logError(function (arg0, arg1) {
            arg0.type = __wbindgen_enum_GpuSamplerBindingType[arg1];
        }, arguments); },
        __wbg_set_type_79cec55caf4cdb6d: function() { return logError(function (arg0, arg1) {
            arg0.type = __wbindgen_enum_GpuBufferBindingType[arg1];
        }, arguments); },
        __wbg_set_type_7f7e54057b801caa: function() { return logError(function (arg0, arg1) {
            arg0.type = __wbindgen_enum_GpuQueryType[arg1];
        }, arguments); },
        __wbg_set_unclipped_depth_32b7caf29fa5633d: function() { return logError(function (arg0, arg1) {
            arg0.unclippedDepth = arg1 !== 0;
        }, arguments); },
        __wbg_set_usage_1ee33d98267e787d: function() { return logError(function (arg0, arg1) {
            arg0.usage = arg1 >>> 0;
        }, arguments); },
        __wbg_set_usage_2365e2704b1fdb10: function() { return logError(function (arg0, arg1) {
            arg0.usage = arg1 >>> 0;
        }, arguments); },
        __wbg_set_usage_d53ee6f0c7aedbfa: function() { return logError(function (arg0, arg1) {
            arg0.usage = arg1 >>> 0;
        }, arguments); },
        __wbg_set_usage_f3e34822998d2147: function() { return logError(function (arg0, arg1) {
            arg0.usage = arg1 >>> 0;
        }, arguments); },
        __wbg_set_vertex_77ed7a1229239b5a: function() { return logError(function (arg0, arg1) {
            arg0.vertex = arg1;
        }, arguments); },
        __wbg_set_view_dimension_893e2d16561e56e8: function() { return logError(function (arg0, arg1) {
            arg0.viewDimension = __wbindgen_enum_GpuTextureViewDimension[arg1];
        }, arguments); },
        __wbg_set_view_dimension_f2c5fe4bf927c3fe: function() { return logError(function (arg0, arg1) {
            arg0.viewDimension = __wbindgen_enum_GpuTextureViewDimension[arg1];
        }, arguments); },
        __wbg_set_view_formats_427069064d8b7139: function() { return logError(function (arg0, arg1, arg2) {
            arg0.viewFormats = getArrayJsValueViewFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_view_formats_9c2f01a6f3b365c7: function() { return logError(function (arg0, arg1, arg2) {
            arg0.viewFormats = getArrayJsValueViewFromWasm0(arg1, arg2);
        }, arguments); },
        __wbg_set_view_gpu_texture_view_35f4655788535c4d: function() { return logError(function (arg0, arg1) {
            arg0.view = arg1;
        }, arguments); },
        __wbg_set_view_gpu_texture_view_a532c825c52042c0: function() { return logError(function (arg0, arg1) {
            arg0.view = arg1;
        }, arguments); },
        __wbg_set_visibility_d8a6821789538c25: function() { return logError(function (arg0, arg1) {
            arg0.visibility = arg1 >>> 0;
        }, arguments); },
        __wbg_set_width_4c3a2252e0dea033: function() { return logError(function (arg0, arg1) {
            arg0.width = arg1 >>> 0;
        }, arguments); },
        __wbg_set_width_b20525f5f4df4eb8: function() { return logError(function (arg0, arg1) {
            arg0.width = arg1 >>> 0;
        }, arguments); },
        __wbg_set_width_f52a20e39808b138: function() { return logError(function (arg0, arg1) {
            arg0.width = arg1 >>> 0;
        }, arguments); },
        __wbg_set_write_mask_42d89f182ade6b2d: function() { return logError(function (arg0, arg1) {
            arg0.writeMask = arg1 >>> 0;
        }, arguments); },
        __wbg_set_x_58965df5af1ad27d: function() { return logError(function (arg0, arg1) {
            arg0.x = arg1 >>> 0;
        }, arguments); },
        __wbg_set_x_f470b03dd54724cd: function() { return logError(function (arg0, arg1) {
            arg0.x = arg1 >>> 0;
        }, arguments); },
        __wbg_set_y_4c44eb40ebca5bfc: function() { return logError(function (arg0, arg1) {
            arg0.y = arg1 >>> 0;
        }, arguments); },
        __wbg_set_y_b79cba22b145de99: function() { return logError(function (arg0, arg1) {
            arg0.y = arg1 >>> 0;
        }, arguments); },
        __wbg_set_z_2e6820ef0f5821ed: function() { return logError(function (arg0, arg1) {
            arg0.z = arg1 >>> 0;
        }, arguments); },
        __wbg_size_00652f74c831ee7c: function() { return logError(function (arg0) {
            const ret = arg0.size;
            return ret;
        }, arguments); },
        __wbg_static_accessor_CREATE_TASK_04be768c473932c0: function() { return logError(function () {
            const ret = typeof console === 'undefined' ? null : console?.createTask;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_static_accessor_GLOBAL_8eb4cd83130a11a0: function() { return logError(function () {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_static_accessor_GLOBAL_THIS_1e7044f654e934db: function() { return logError(function () {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_static_accessor_SELF_d8b50611246a6d92: function() { return logError(function () {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_static_accessor_WINDOW_fd0bc376bf0f8b42: function() { return logError(function () {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_subgroupMaxSize_b43be0aa16182403: function() { return logError(function (arg0) {
            const ret = arg0.subgroupMaxSize;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_subgroupMinSize_03feb6ee0cda6775: function() { return logError(function (arg0) {
            const ret = arg0.subgroupMinSize;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_submit_077c85cc28e36892: function() { return logError(function (arg0, arg1, arg2) {
            arg0.submit(getArrayJsValueViewFromWasm0(arg1, arg2));
        }, arguments); },
        __wbg_then_7a850dae4493f353: function() { return logError(function (arg0, arg1, arg2) {
            const ret = arg0.then(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_then_8ebf7f4d2b402f98: function() { return logError(function (arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        }, arguments); },
        __wbg_then_b830475380919203: function() { return logError(function (arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        }, arguments); },
        __wbg_unconfigure_835307f58dc68d80: function() { return logError(function (arg0) {
            arg0.unconfigure();
        }, arguments); },
        __wbg_unmap_6a96b14c9ef5f7f5: function() { return logError(function (arg0) {
            arg0.unmap();
        }, arguments); },
        __wbg_usage_eb336a28af1c9fcf: function() { return logError(function (arg0) {
            const ret = arg0.usage;
            _assertNum(ret);
            return ret;
        }, arguments); },
        __wbg_valueOf_24fc886d85bf55b5: function() { return logError(function (arg0) {
            const ret = arg0.valueOf();
            return ret;
        }, arguments); },
        __wbg_value_c227f843d21da141: function() { return logError(function (arg0) {
            const ret = arg0.value;
            return ret;
        }, arguments); },
        __wbg_vendor_648d57f04f6d7bb8: function() { return logError(function (arg0, arg1) {
            const ret = arg1.vendor;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        }, arguments); },
        __wbg_wgslLanguageFeatures_7fc49d2febd57ad1: function() { return logError(function (arg0) {
            const ret = arg0.wgslLanguageFeatures;
            return ret;
        }, arguments); },
        __wbg_writeBuffer_f4bb3f54adfe1330: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
            arg0.writeBuffer(arg1, arg2, getArrayU8FromWasm0(arg3, arg4), arg5, arg6);
        }, arguments); },
        __wbg_writeTexture_30e592e8c061c3d9: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.writeTexture(arg1, getArrayU8FromWasm0(arg2, arg3), arg4, arg5);
        }, arguments); },
        __wbindgen_generic_0000000000000001: function() { return logError(function (arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 368, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__hf91c2a62bb24aec0);
            return ret;
        }, arguments); },
        __wbindgen_generic_0000000000000002: function() { return logError(function (arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("GPUDevice")], shim_idx: 223, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__hb52fd36053a2e8eb);
            return ret;
        }, arguments); },
        __wbindgen_generic_0000000000000003: function() { return logError(function (arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("GPUDeviceLostInfo")], shim_idx: 225, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__hbb31a206cd0bdb79);
            return ret;
        }, arguments); },
        __wbindgen_generic_0000000000000004: function() { return logError(function (arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("GPUUncapturedErrorEvent")], shim_idx: 220, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__hcfc1dc1a875adce5);
            return ret;
        }, arguments); },
        __wbindgen_generic_0000000000000005: function() { return logError(function (arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("any")], shim_idx: 221, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__hc52328d8cde8c446);
            return ret;
        }, arguments); },
        __wbindgen_generic_0000000000000006: function() { return logError(function (arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("any")], shim_idx: 222, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h5c2c9a75a6746f64);
            return ret;
        }, arguments); },
        __wbindgen_generic_0000000000000007: function() { return logError(function (arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("undefined")], shim_idx: 224, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h43b53cc557bf6e42);
            return ret;
        }, arguments); },
        __wbindgen_generic_0000000000000008: function() { return logError(function (arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        }, arguments); },
        __wbindgen_generic_0000000000000009: function() { return logError(function (arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        }, arguments); },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./renderer_wgpu_probe_bg.js": import0,
    };
}


//#endregion
function wasm_bindgen__convert__closures_____invoke__hd4a907be06eb37af(arg0, arg1) {
    _assertNum(arg0);
    _assertNum(arg1);
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__hd4a907be06eb37af(arg0, arg1);
    return ret !== 0;
}

function wasm_bindgen__convert__closures_____invoke__hbb31a206cd0bdb79(arg0, arg1, arg2) {
    _assertNum(arg0);
    _assertNum(arg1);
    wasm.wasm_bindgen__convert__closures_____invoke__hbb31a206cd0bdb79(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__hcfc1dc1a875adce5(arg0, arg1, arg2) {
    _assertNum(arg0);
    _assertNum(arg1);
    wasm.wasm_bindgen__convert__closures_____invoke__hcfc1dc1a875adce5(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__hf91c2a62bb24aec0(arg0, arg1, arg2) {
    _assertNum(arg0);
    _assertNum(arg1);
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__hf91c2a62bb24aec0(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__hb52fd36053a2e8eb(arg0, arg1, arg2) {
    _assertNum(arg0);
    _assertNum(arg1);
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__hb52fd36053a2e8eb(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__hc52328d8cde8c446(arg0, arg1, arg2) {
    _assertNum(arg0);
    _assertNum(arg1);
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__hc52328d8cde8c446(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__h5c2c9a75a6746f64(arg0, arg1, arg2) {
    _assertNum(arg0);
    _assertNum(arg1);
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h5c2c9a75a6746f64(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__h43b53cc557bf6e42(arg0, arg1, arg2) {
    _assertNum(arg0);
    _assertNum(arg1);
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h43b53cc557bf6e42(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__h920b1d6c4a49b2c0(arg0, arg1, arg2, arg3) {
    _assertNum(arg0);
    _assertNum(arg1);
    wasm.wasm_bindgen__convert__closures_____invoke__h920b1d6c4a49b2c0(arg0, arg1, arg2, arg3);
}


const __wbindgen_enum_GpuAddressMode = ["clamp-to-edge", "repeat", "mirror-repeat"];


const __wbindgen_enum_GpuAutoLayoutMode = ["auto"];


const __wbindgen_enum_GpuBlendFactor = ["zero", "one", "src", "one-minus-src", "src-alpha", "one-minus-src-alpha", "dst", "one-minus-dst", "dst-alpha", "one-minus-dst-alpha", "src-alpha-saturated", "constant", "one-minus-constant", "src1", "one-minus-src1", "src1-alpha", "one-minus-src1-alpha"];


const __wbindgen_enum_GpuBlendOperation = ["add", "subtract", "reverse-subtract", "min", "max"];


const __wbindgen_enum_GpuBufferBindingType = ["uniform", "storage", "read-only-storage"];


const __wbindgen_enum_GpuCanvasAlphaMode = ["opaque", "premultiplied"];


const __wbindgen_enum_GpuCanvasToneMappingMode = ["standard", "extended"];


const __wbindgen_enum_GpuCompareFunction = ["never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always"];


const __wbindgen_enum_GpuCullMode = ["none", "front", "back"];


const __wbindgen_enum_GpuDeviceLostReason = ["unknown", "destroyed"];


const __wbindgen_enum_GpuErrorFilter = ["validation", "out-of-memory", "internal"];


const __wbindgen_enum_GpuFilterMode = ["nearest", "linear"];


const __wbindgen_enum_GpuFrontFace = ["ccw", "cw"];


const __wbindgen_enum_GpuIndexFormat = ["uint16", "uint32"];


const __wbindgen_enum_GpuLoadOp = ["load", "clear"];


const __wbindgen_enum_GpuMipmapFilterMode = ["nearest", "linear"];


const __wbindgen_enum_GpuPowerPreference = ["low-power", "high-performance"];


const __wbindgen_enum_GpuPrimitiveTopology = ["point-list", "line-list", "line-strip", "triangle-list", "triangle-strip"];


const __wbindgen_enum_GpuQueryType = ["occlusion", "timestamp"];


const __wbindgen_enum_GpuSamplerBindingType = ["filtering", "non-filtering", "comparison"];


const __wbindgen_enum_GpuStencilOperation = ["keep", "zero", "replace", "invert", "increment-clamp", "decrement-clamp", "increment-wrap", "decrement-wrap"];


const __wbindgen_enum_GpuStorageTextureAccess = ["write-only", "read-only", "read-write"];


const __wbindgen_enum_GpuStoreOp = ["store", "discard"];


const __wbindgen_enum_GpuTextureAspect = ["all", "stencil-only", "depth-only"];


const __wbindgen_enum_GpuTextureDimension = ["1d", "2d", "3d"];


const __wbindgen_enum_GpuTextureFormat = ["r8unorm", "r8snorm", "r8uint", "r8sint", "r16unorm", "r16snorm", "r16uint", "r16sint", "r16float", "rg8unorm", "rg8snorm", "rg8uint", "rg8sint", "r32uint", "r32sint", "r32float", "rg16unorm", "rg16snorm", "rg16uint", "rg16sint", "rg16float", "rgba8unorm", "rgba8unorm-srgb", "rgba8snorm", "rgba8uint", "rgba8sint", "bgra8unorm", "bgra8unorm-srgb", "rgb9e5ufloat", "rgb10a2uint", "rgb10a2unorm", "rg11b10ufloat", "rg32uint", "rg32sint", "rg32float", "rgba16unorm", "rgba16snorm", "rgba16uint", "rgba16sint", "rgba16float", "rgba32uint", "rgba32sint", "rgba32float", "stencil8", "depth16unorm", "depth24plus", "depth24plus-stencil8", "depth32float", "depth32float-stencil8", "bc1-rgba-unorm", "bc1-rgba-unorm-srgb", "bc2-rgba-unorm", "bc2-rgba-unorm-srgb", "bc3-rgba-unorm", "bc3-rgba-unorm-srgb", "bc4-r-unorm", "bc4-r-snorm", "bc5-rg-unorm", "bc5-rg-snorm", "bc6h-rgb-ufloat", "bc6h-rgb-float", "bc7-rgba-unorm", "bc7-rgba-unorm-srgb", "etc2-rgb8unorm", "etc2-rgb8unorm-srgb", "etc2-rgb8a1unorm", "etc2-rgb8a1unorm-srgb", "etc2-rgba8unorm", "etc2-rgba8unorm-srgb", "eac-r11unorm", "eac-r11snorm", "eac-rg11unorm", "eac-rg11snorm", "astc-4x4-unorm", "astc-4x4-unorm-srgb", "astc-5x4-unorm", "astc-5x4-unorm-srgb", "astc-5x5-unorm", "astc-5x5-unorm-srgb", "astc-6x5-unorm", "astc-6x5-unorm-srgb", "astc-6x6-unorm", "astc-6x6-unorm-srgb", "astc-8x5-unorm", "astc-8x5-unorm-srgb", "astc-8x6-unorm", "astc-8x6-unorm-srgb", "astc-8x8-unorm", "astc-8x8-unorm-srgb", "astc-10x5-unorm", "astc-10x5-unorm-srgb", "astc-10x6-unorm", "astc-10x6-unorm-srgb", "astc-10x8-unorm", "astc-10x8-unorm-srgb", "astc-10x10-unorm", "astc-10x10-unorm-srgb", "astc-12x10-unorm", "astc-12x10-unorm-srgb", "astc-12x12-unorm", "astc-12x12-unorm-srgb"];


const __wbindgen_enum_GpuTextureSampleType = ["float", "unfilterable-float", "depth", "sint", "uint"];


const __wbindgen_enum_GpuTextureViewDimension = ["1d", "2d", "2d-array", "cube", "cube-array", "3d"];


const __wbindgen_enum_GpuVertexFormat = ["uint8", "uint8x2", "uint8x4", "sint8", "sint8x2", "sint8x4", "unorm8", "unorm8x2", "unorm8x4", "snorm8", "snorm8x2", "snorm8x4", "uint16", "uint16x2", "uint16x4", "sint16", "sint16x2", "sint16x4", "unorm16", "unorm16x2", "unorm16x4", "snorm16", "snorm16x2", "snorm16x4", "float16", "float16x2", "float16x4", "float32", "float32x2", "float32x3", "float32x4", "uint32", "uint32x2", "uint32x3", "uint32x4", "sint32", "sint32x2", "sint32x3", "sint32x4", "unorm10-10-10-2", "unorm8x4-bgra"];


const __wbindgen_enum_GpuVertexStepMode = ["vertex", "instance"];
const RendererFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_renderer_free(ptr, 1));


//#region intrinsics
function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertBoolean(n) {
    if (typeof(n) !== 'boolean') {
        throw new Error(`expected a boolean argument, found ${typeof(n)}`);
    }
}

function _assertNum(n) {
    if (typeof(n) !== 'number') throw new Error(`expected a number argument, found ${typeof(n)}`);
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayJsValueViewFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    return result;
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function logError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        let error = (function () {
            try {
                return e instanceof Error ? `${e.message}\n\nStack:\n${e.stack}` : e.toString();
            } catch(_) {
                return "<failed to stringify thrown value>";
            }
        }());
        console.error("wasm-bindgen: imported JS function that was not marked as `catch` threw an error:", error);
        throw e;
    }
}

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (typeof(arg) !== 'string') throw new Error(`expected a string argument, found ${typeof(arg)}`);
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);
        if (ret.read !== arg.length) throw new Error('failed to pass whole string');
        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;


//#endregion

//#region wasm loading
let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('renderer_wgpu_probe_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
//#endregion
export { wasm as __wasm }
