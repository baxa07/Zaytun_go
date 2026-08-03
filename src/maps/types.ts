export type MapProvider='mock'|'yandex'
export type NavigationProvider='yandex'|'google'|'browser'
export interface MapCoordinate{latitude:number;longitude:number}
export interface GeocodingResult{coordinate:MapCoordinate;formattedAddress:string;providerPlaceId?:string;district?:string;street?:string;house?:string}
export interface AddressSuggestion extends GeocodingResult{label:string}
export type MapSelectionState='NOT_SELECTED'|'SELECTED'|'REVERSE_GEOCODING'|'SUGGESTION_AVAILABLE'|'CONFIRMED'|'NEEDS_RECONFIRMATION'|'ERROR'
export interface MapLocationSelection{coordinate?:MapCoordinate;state:MapSelectionState;suggestion?:AddressSuggestion;confirmedAt?:string;provider:MapProvider;error?:string}
export interface MapController{setCoordinate(coordinate:MapCoordinate):void;dispose():void}
export interface MapAdapter{readonly provider:MapProvider;load():Promise<void>;initialize(container:HTMLElement,options:{center:MapCoordinate;zoom:number;selected?:MapCoordinate;onSelect:(coordinate:MapCoordinate)=>void}):Promise<MapController>;search(query:string):Promise<AddressSuggestion[]>;reverseGeocode(coordinate:MapCoordinate):Promise<GeocodingResult|null>}
export class MapProviderError extends Error{constructor(public code:'MISSING_CONFIG'|'LOAD_FAILED'|'GEOCODING_FAILED'|'NO_RESULTS'|'UNAVAILABLE',message:string,public retryable=false){super(message);this.name='MapProviderError'}}
