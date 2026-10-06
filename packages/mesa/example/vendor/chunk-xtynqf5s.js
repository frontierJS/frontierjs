class c extends Error{name="Assertion";code="ERR_ASSERTION";constructor(e,t,i,u,s){super(e);if(Error.captureStackTrace)Error.captureStackTrace(this,this.constructor);this.actual=t,this.expected=i,this.generated=s,this.operator=u}}function n(e,t){f(Boolean(e),!1,!0,"ok","Expected value to be truthy",t)}function f(e,t,i,u,s,r){if(!e)throw r instanceof Error?r:new c(r||s,t,i,u,!r)}
export{n};
